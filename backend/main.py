from concurrent.futures import ThreadPoolExecutor, TimeoutError
from collections import Counter
import json
import os
import re
import shutil
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai
from pydantic import BaseModel

from interview_generator import evaluate_answer, get_next_interview_question
from resume_parser import extract_resume


def _load_local_env():
    for path in (
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"),
    ):
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as env_file:
            for line in env_file:
                key, separator, value = line.strip().partition("=")
                if separator and key and key not in os.environ:
                    os.environ[key] = value.strip().strip('"').strip("'")


_load_local_env()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_TIMEOUT_SECONDS = 5
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

UPLOAD_DIR = "../uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)


class InterviewSessionPayload(BaseModel):
    structured_profile: dict
    jd_text: str = ""
    history: list = []
    duration_mode: str = "standard"
    latest_evaluation: dict | None = None


class AnswerEvaluationPayload(BaseModel):
    structured_profile: dict
    jd_text: str = ""
    history: list = []
    duration_mode: str = "standard"
    question: str
    answer: str


def clean_items(items, limit=10):
    seen = set()
    cleaned = []
    for item in items:
        value = re.sub(r"\s+", " ", str(item)).strip(" -:\t\r\n")
        key = value.lower()
        if value and key not in seen:
            seen.add(key)
            cleaned.append(value)
        if len(cleaned) >= limit:
            break
    return cleaned


def run_with_timeout(function, timeout_seconds, fallback):
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(function)
    try:
        return future.result(timeout=timeout_seconds)
    except TimeoutError:
        future.cancel()
        return fallback
    except Exception:
        return fallback
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def analyze_resume_locally(resume_text: str):
    text = resume_text or ""
    lower_text = text.lower()
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    known_tech = [
        "Python", "Java", "JavaScript", "TypeScript", "React", "Node.js",
        "Express", "FastAPI", "Django", "Flask", "MongoDB", "MySQL",
        "PostgreSQL", "SQL", "HTML", "CSS", "Tailwind", "Bootstrap",
        "Git", "GitHub", "Docker", "Machine Learning", "Deep Learning",
        "AI", "NLP", "OpenCV", "Pandas", "NumPy", "TensorFlow", "PyTorch",
        "Firebase", "REST API",
    ]
    technologies = [tech for tech in known_tech if tech.lower() in lower_text]

    skill_words = [
        "communication", "leadership", "problem solving", "teamwork",
        "debugging", "data analysis", "web development", "backend",
        "frontend", "database", "api", "automation", "cloud",
    ]
    skills = technologies + [word.title() for word in skill_words if word in lower_text]

    projects = []
    education = []
    certifications = []
    for line in lines:
        low = line.lower()
        if any(word in low for word in ["project", "system", "application", "website", "portal", "analyzer"]):
            projects.append(line)
        if any(word in low for word in ["college", "university", "b.tech", "bachelor", "engineering", "degree"]):
            education.append(line)
        if any(word in low for word in ["certification", "certificate", "course", "internship"]):
            certifications.append(line)

    return {
        "skills": clean_items(skills, 12) or ["Communication", "Problem Solving"],
        "projects": clean_items(projects, 8) or ["Resume project details detected in uploaded document"],
        "technologies": clean_items(technologies, 12) or ["Technologies will be refined during interview"],
        "education": clean_items(education, 6) or ["Education details detected in resume"],
        "certifications": clean_items(certifications, 6),
    }


def calculate_ats_result(resume_text: str, profile: dict, jd_text: str):
    text = resume_text or ""
    lower_text = text.lower()
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", lower_text)
    word_counts = Counter(words)
    word_count = len(words)

    headings = {
        "skills": bool(re.search(r"\b(skills|technical skills|core competencies)\b", lower_text)),
        "projects": bool(re.search(r"\b(projects|academic projects|personal projects)\b", lower_text)),
        "education": bool(re.search(r"\b(education|academic background|qualification)\b", lower_text)),
        "experience": bool(re.search(r"\b(experience|internship|employment|work history)\b", lower_text)),
    }
    action_verbs = [
        "built", "developed", "designed", "implemented", "created", "improved",
        "optimized", "deployed", "managed", "led", "automated", "analyzed",
    ]
    action_count = sum(word_counts[verb] for verb in action_verbs)
    has_metrics = bool(re.search(r"\b\d+(?:\.\d+)?\s*(?:%|ms|seconds?|users?|projects?|x)\b", lower_text))

    stop_words = {
        "and", "the", "with", "for", "from", "that", "this", "your", "you",
        "are", "our", "will", "have", "has", "into", "using", "work", "role",
        "job", "team", "who", "but", "not", "all", "can", "skills", "experience",
    }
    jd_terms = [
        word for word in re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", (jd_text or "").lower())
        if word not in stop_words
    ]
    unique_jd_terms = list(dict.fromkeys(jd_terms))[:80]
    matched_keywords = [term for term in unique_jd_terms if term in lower_text]
    missing_keywords = [term for term in unique_jd_terms if term not in lower_text][:10]

    section_score = sum(headings.values()) * 5
    content_score = min(25, round(word_count / 20))
    evidence_score = min(15, action_count * 2) + (10 if has_metrics else 0)
    profile_score = min(
        15,
        len(profile.get("skills", [])) + len(profile.get("technologies", [])),
    )
    if unique_jd_terms:
        keyword_score = round(len(matched_keywords) / len(unique_jd_terms) * 25)
        score = min(96, 20 + section_score + content_score // 2 + evidence_score // 2 + profile_score // 2 + keyword_score)
    else:
        score = min(92, 25 + section_score + content_score + evidence_score + profile_score)
    score = max(35, score)

    tips = []
    missing_headings = [name.title() for name, found in headings.items() if not found]
    if missing_headings:
        tips.append(f"Add clear ATS-friendly headings for: {', '.join(missing_headings)}.")
    if not has_metrics:
        tips.append("Add measurable outcomes such as accuracy, response time, users, or percentage improvements.")
    if action_count < 3:
        tips.append("Start more project bullets with action verbs such as Built, Developed, Implemented, or Deployed.")
    if word_count < 180:
        tips.append("Add more detail to projects and experience; the parsed resume is currently quite short.")
    elif word_count > 900:
        tips.append("Shorten the resume and keep the most role-relevant achievements.")
    if missing_keywords:
        tips.append("Include relevant missing job-description keywords naturally where they match your real experience.")
    if not tips:
        tips.append("The resume has strong structure; tailor the summary and top projects for each target role.")

    return {
        "score": score,
        "matched_keywords": matched_keywords[:12],
        "missing_keywords": missing_keywords,
        "tips": tips[:5],
        "document_stats": {
            "word_count": word_count,
            "action_verbs": action_count,
            "has_metrics": has_metrics,
            "sections_found": [name.title() for name, found in headings.items() if found],
        },
    }


def analyze_resume_with_gemini(resume_text: str):
    local_fallback = analyze_resume_locally(resume_text)

    if not GEMINI_API_KEY or GEMINI_API_KEY == "YOUR_ACTUAL_GEMINI_API_KEY_HERE":
        return local_fallback

    prompt = (
        "You are an expert technical recruiter and ATS analyzer. "
        "Analyze the following resume text and extract the candidate data into strict JSON.\n\n"
        "Return exactly these keys:\n"
        "- skills: array of technical and soft skills\n"
        "- projects: array of projects with a short title or description\n"
        "- technologies: array of languages, frameworks, databases, or tools\n"
        "- education: array of degrees, colleges, and graduation timelines\n"
        "- certifications: array of certifications or course credentials\n\n"
        "Return raw JSON only. Do not use markdown.\n\n"
        f"Resume Text:\n{resume_text[:9000]}"
    )

    def call_gemini():
        for model_name in ["gemini-1.5-flash", "gemini-2.5-flash"]:
            try:
                model = genai.GenerativeModel(model_name)
                response = model.generate_content(
                    prompt,
                    generation_config={"temperature": 0.2, "max_output_tokens": 900},
                    request_options={"timeout": GEMINI_TIMEOUT_SECONDS},
                )
                if response and response.text:
                    return response.text.strip()
            except Exception:
                continue
        return ""

    response_text = run_with_timeout(call_gemini, GEMINI_TIMEOUT_SECONDS + 2, "")
    if not response_text:
        return local_fallback

    try:
        markdown_tag = "`" * 3
        if response_text.startswith(markdown_tag):
            lines = response_text.split("\n")
            response_text = "\n".join(lines[1:-1])

        parsed = json.loads(response_text)
        return {
            "skills": clean_items(parsed.get("skills", []), 12) or local_fallback["skills"],
            "projects": clean_items(parsed.get("projects", []), 8) or local_fallback["projects"],
            "technologies": clean_items(parsed.get("technologies", []), 12) or local_fallback["technologies"],
            "education": clean_items(parsed.get("education", []), 6) or local_fallback["education"],
            "certifications": clean_items(parsed.get("certifications", []), 6) or local_fallback["certifications"],
        }
    except Exception:
        return local_fallback


@app.get("/")
def home():
    return {"message": "AI Mock Interview Backend Running"}


@app.post("/upload_resume/")
async def upload_resume(file: UploadFile = File(...), jd_text: str = Form(None)):
    safe_name = os.path.basename(file.filename)
    file_location = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{safe_name}")
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        raw_text = extract_resume(file_location)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"File parse failed: {exc}") from exc

    structured_profile = analyze_resume_with_gemini(raw_text)
    interview_mode = "Company-Specific Interview" if jd_text and jd_text.strip() else "Practice Interview"

    return {
        "filename": file.filename,
        "interview_mode": interview_mode,
        "job_description_provided": bool(jd_text),
        "structured_profile": structured_profile,
    }


@app.post("/ats/analyze/")
async def analyze_ats(file: UploadFile = File(...), jd_text: str = Form("")):
    safe_name = os.path.basename(file.filename)
    file_location = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{safe_name}")
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        raw_text = extract_resume(file_location)
        if not raw_text.strip():
            raise HTTPException(status_code=422, detail="No readable text was found in this resume.")
        profile = analyze_resume_with_gemini(raw_text)
        result = calculate_ats_result(raw_text, profile, jd_text)
        return {
            "filename": file.filename,
            "structured_profile": profile,
            **result,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ATS analysis failed: {exc}") from exc
    finally:
        try:
            os.remove(file_location)
        except OSError:
            pass


@app.post("/interview/next-question/")
async def next_question(payload: InterviewSessionPayload):
    next_question_text = get_next_interview_question(
        resume_summary=payload.structured_profile,
        jd_text=payload.jd_text,
        history=payload.history,
        duration_mode=payload.duration_mode,
        latest_evaluation=payload.latest_evaluation,
    )
    return {"next_question": next_question_text}


@app.post("/interview/evaluate-answer/")
async def evaluate_interview_answer(payload: AnswerEvaluationPayload):
    evaluation = evaluate_answer(
        question=payload.question,
        answer=payload.answer,
        resume_summary=payload.structured_profile,
        jd_text=payload.jd_text,
    )
    next_history = [
        *payload.history,
        {"role": "ai", "text": payload.question},
        {"role": "user", "text": payload.answer, "evaluation": evaluation},
    ]
    next_question_text = get_next_interview_question(
        resume_summary=payload.structured_profile,
        jd_text=payload.jd_text,
        history=next_history,
        duration_mode=payload.duration_mode,
        latest_evaluation=evaluation,
    )
    return {
        "evaluation": evaluation,
        "next_question": next_question_text,
    }
