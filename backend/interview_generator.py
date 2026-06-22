from concurrent.futures import ThreadPoolExecutor, TimeoutError
from difflib import SequenceMatcher
import json
import os
import re

import google.generativeai as genai


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
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_TIMEOUT_SECONDS = 5
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

FILLERS = {
    "actually", "basically", "honestly", "like", "literally", "maybe",
    "probably", "stuff", "things", "umm", "um", "uh", "you know",
}
STOP_WORDS = {
    "about", "after", "again", "also", "because", "could", "from", "have",
    "into", "just", "more", "that", "their", "there", "these", "they",
    "this", "through", "using", "what", "when", "where", "which", "while",
    "with", "would", "your", "tell", "explain", "describe", "myself",
    "thank", "good", "afternoon", "morning", "evening", "company",
}

ROLE_TERMS = {
    "ai": "AI",
    "artificial": "AI",
    "machine": "machine learning",
    "learning": "machine learning",
    "intern": "AI internship",
    "internship": "AI internship",
    "developer": "developer role",
    "python": "Python",
    "fastapi": "FastAPI",
    "react": "React",
    "database": "database",
    "sql": "SQL",
    "model": "AI model",
}


def _list_items(value):
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()] if value else []


def _tokens(text):
    return [
        token for token in re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", (text or "").lower())
        if token not in STOP_WORDS
    ]


def _questions(history):
    return [turn.get("text", "") for turn in history if turn.get("role") == "ai"]


def _answers(history):
    return [turn.get("text", "") for turn in history if turn.get("role") == "user"]


def _too_similar(candidate, asked):
    normalized = " ".join(_tokens(candidate))
    for question in asked:
        previous = " ".join(_tokens(question))
        if SequenceMatcher(None, normalized, previous).ratio() > 0.68:
            return True
    return False


def _profile_topics(resume_summary):
    projects = [
        item for item in _list_items(resume_summary.get("projects"))
        if len(item.split()) <= 14 and item.count(",") <= 1
    ]
    technologies = [
        item for item in _list_items(resume_summary.get("technologies"))
        if len(item.split()) <= 6
    ]
    skills = [
        item for item in _list_items(resume_summary.get("skills"))
        if len(item.split()) <= 6
    ]
    return projects, technologies, skills


def _display_topic(topic, fallback):
    topic = str(topic or "").strip(" ,.;:")
    if not topic:
        return fallback
    words = topic.split()
    if len(words) > 10 or topic.count(",") > 1:
        return fallback
    return topic


def _first_display_topic(items, fallback=""):
    for item in items:
        readable = _display_topic(item, "")
        if readable:
            return readable
    return fallback


def _mentioned_topics(answer, resume_summary, jd_text):
    answer_tokens = set(_tokens(answer))
    projects, technologies, skills = _profile_topics(resume_summary)
    topics = []

    for raw, label in ROLE_TERMS.items():
        if raw in answer_tokens and label not in topics:
            topics.append(label)

    for item in technologies + skills + projects:
        item_tokens = set(_tokens(item))
        if item_tokens and item_tokens & answer_tokens:
            readable = _display_topic(item, "")
            if readable and readable not in topics:
                topics.append(readable)

    for term in _tokens(jd_text):
        if term in answer_tokens and term not in topics:
            topics.append(term)

    return topics[:4]


def _latest_answer_followups(resume_summary, jd_text, history, latest_evaluation=None):
    answers = _answers(history)
    if not answers:
        return []

    last_answer = answers[-1]
    topics = _mentioned_topics(last_answer, resume_summary, jd_text)
    primary = topics[0] if topics else "that interest"
    projects, technologies, skills = _profile_topics(resume_summary)
    resume_anchor = (
        _first_display_topic(projects)
        or _first_display_topic(technologies)
        or _first_display_topic(skills)
        or "one project or skill from your background"
    )

    answer_words = len(re.findall(r"\b[\w+#.-]+\b", last_answer))
    relevance = latest_evaluation.get("relevance", 75) if latest_evaluation else 75
    completeness = latest_evaluation.get("completeness", 75) if latest_evaluation else 75
    needs_followup = answer_words < 55 or relevance < 72 or completeness < 72

    if not needs_followup:
        return []

    followups = [
        f"You mentioned {primary}. Can you connect that interest to one specific project or skill from your resume, especially {resume_anchor}?",
        f"What is one AI-related concept or tool you have actually practiced, and how did you apply it in {resume_anchor}?",
        f"If this was an internship interview, what evidence from your resume would prove that you are ready to contribute to {primary} work?",
    ]

    if jd_text.strip():
        followups.insert(
            1,
            f"Looking at the target role, why does your background make you suitable for {primary}, and what would you learn first after joining?",
        )
    return followups


def _question_candidates(resume_summary, jd_text, history, latest_evaluation=None):
    projects, technologies, skills = _profile_topics(resume_summary)
    answers = _answers(history)
    answer_count = len(answers)
    last_answer = answers[-1] if answers else ""
    last_terms = _tokens(last_answer)
    project = _display_topic(projects[answer_count % len(projects)], "one project you are proud of") if projects else "one project you are proud of"
    technology = _display_topic(technologies[answer_count % len(technologies)], "your main technical skill") if technologies else (
        skills[answer_count % len(skills)] if skills else "your main technical skill"
    )
    technology = _display_topic(technology, "your main technical skill")
    alternate_technology = _display_topic(technologies[(answer_count + 1) % len(technologies)], technology) if len(technologies) > 1 else technology

    if answer_count == 0:
        return [
            "Please introduce yourself and connect your background to the kind of role you are targeting.",
            f"Give me a concise introduction, then walk me through {project}.",
        ]

    candidates = _latest_answer_followups(resume_summary, jd_text, history, latest_evaluation)
    weak_relevance = latest_evaluation and latest_evaluation.get("relevance", 100) < 55
    shallow = len(last_terms) < 24 or (latest_evaluation and latest_evaluation.get("completeness", 100) < 55)

    if weak_relevance:
        candidates.extend([
            f"Let us make that more specific. What exactly was your responsibility when using {technology}, and what result did your work produce?",
            "Could you answer that again using one concrete situation, the action you personally took, and the final result?",
        ])
    elif shallow:
        candidates.extend([
            f"You mentioned {technology}. How did you use it in practice, and why did you choose it over an alternative?",
            "Please go one level deeper: what was the main technical decision you made, and what trade-off did it involve?",
        ])

    stage = answer_count % 6
    if stage == 1:
        candidates.extend([
            f"In {project}, what part did you personally build, and how did the complete system work from input to output?",
            f"What was the hardest implementation detail in {project}, and how did you validate your solution?",
        ])
    elif stage == 2:
        candidates.extend([
            f"Compare {technology} with another approach you considered. Why was it the better choice for your use case?",
            f"How would you debug a production issue in a system built with {technology}?",
        ])
    elif stage == 3:
        candidates.extend([
            "Tell me about a time your first solution failed. How did you diagnose the problem and change your approach?",
            "Describe a difficult team or project situation. What did you do personally, and what did you learn?",
        ])
    elif stage == 4:
        candidates.extend([
            f"If the usage of {project} increased ten times, what would break first and how would you redesign it?",
            f"How would you test, secure, and monitor a production feature built with {alternate_technology}?",
        ])
    elif stage == 5:
        candidates.extend([
            "Which claim on your resume best represents your current ability, and what evidence can you give to support it?",
            "What technical area on your resume are you least confident about, and what are you doing to improve it?",
        ])
    else:
        candidates.extend([
            "Imagine you join the team next week. How would you understand an unfamiliar codebase and deliver your first useful change?",
            "What kind of engineering problem motivates you most, and how does your recent work demonstrate that?",
        ])

    if jd_text.strip():
        profile_terms = {
            term
            for item in technologies + skills
            for term in _tokens(item)
        }
        jd_terms = [
            term for term in dict.fromkeys(_tokens(jd_text))
            if term in profile_terms
        ][:8]
        if jd_terms:
            role_topic = jd_terms[answer_count % len(jd_terms)]
            candidates.insert(
                1,
                f"This role emphasizes {role_topic}. Tell me about the strongest evidence that you can apply it effectively.",
            )
    return candidates


def _fallback_question(resume_summary, jd_text, history, latest_evaluation=None):
    asked = _questions(history)
    candidates = _question_candidates(resume_summary, jd_text, history, latest_evaluation)
    for candidate in candidates:
        if not _too_similar(candidate, asked):
            return candidate
    return f"Give me another specific example from your experience that we have not discussed yet. Focus on your decision-making and measurable result."


def _run_with_timeout(function, timeout_seconds, fallback):
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(function)
    try:
        return future.result(timeout=timeout_seconds)
    except (TimeoutError, Exception):
        future.cancel()
        return fallback
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _local_evaluation(question, answer, resume_summary, jd_text):
    answer_words = re.findall(r"\b[\w+#.-]+\b", answer)
    lower_answer = answer.lower()
    question_terms = set(_tokens(question))
    context_terms = set(
        _tokens(" ".join(
            _list_items(resume_summary.get("skills"))
            + _list_items(resume_summary.get("technologies"))
            + _list_items(resume_summary.get("projects"))
        ))
    )
    jd_terms = set(_tokens(jd_text))
    expected_terms = question_terms | context_terms | jd_terms
    used_terms = set(_tokens(answer))
    overlap = len(used_terms & expected_terms)
    filler_count = sum(lower_answer.count(filler) for filler in FILLERS)
    sentence_count = max(1, len(re.findall(r"[.!?]+", answer)))
    has_example = any(term in lower_answer for term in ["project", "when", "example", "built", "developed", "implemented"])
    has_action = any(term in lower_answer for term in ["i built", "i developed", "i designed", "i implemented", "i solved", "i used"])
    has_result = bool(re.search(r"\b(result|improved|reduced|increased|achieved|\d+%|\d+ users?)\b", lower_answer))
    hedges = sum(lower_answer.count(term) for term in ["i think", "maybe", "probably", "not sure", "i guess"])

    length_score = min(35, len(answer_words))
    structure_score = min(25, sentence_count * 7 + (8 if has_example else 0))
    clarity = max(25, min(96, 45 + length_score + structure_score - filler_count * 4))
    relevance = max(20, min(96, 42 + overlap * 8 + (10 if has_action else 0)))
    confidence = max(20, min(96, 72 + (8 if has_action else 0) + (6 if has_result else 0) - hedges * 8 - filler_count * 2))
    completeness = max(20, min(96, 35 + length_score + (12 if has_action else 0) + (14 if has_result else 0)))

    technology = next(iter(_list_items(resume_summary.get("technologies"))), "the relevant technology")
    suggestion = (
        f"I would use one concrete example and answer the question directly: describe the situation, explain my "
        f"personal responsibility, show how I used {technology}, mention the main decision or challenge, and finish "
        f"with the result or lesson learned."
    )
    strengths = []
    improvements = []
    if relevance >= 70:
        strengths.append("The answer stayed connected to the question.")
    if clarity >= 70:
        strengths.append("The main idea was understandable.")
    if has_action:
        strengths.append("You described personal ownership.")
    if not has_result:
        improvements.append("Finish with a specific outcome or measurable result.")
    if filler_count:
        improvements.append("Reduce filler phrases and pause briefly instead.")
    if relevance < 65:
        improvements.append("Answer the exact question before adding background context.")
    if len(answer_words) < 35:
        improvements.append("Add one concrete technical detail using the STAR structure.")

    return {
        "clarity": round(clarity),
        "relevance": round(relevance),
        "confidence": round(confidence),
        "completeness": round(completeness),
        "suggested_answer": suggestion,
        "strengths": strengths[:2] or ["You completed the response and provided interview context."],
        "improvements": improvements[:3] or ["Add one more measurable detail to make the answer stronger."],
    }


def evaluate_answer(question, answer, resume_summary, jd_text):
    fallback = _local_evaluation(question, answer, resume_summary, jd_text)
    if not GEMINI_API_KEY:
        return fallback

    prompt = f"""
You are a strict but supportive professional interview evaluator.
Question: {question}
Candidate answer: {answer}
Resume profile: {resume_summary}
Job description: {jd_text or "Not provided"}

Return raw JSON only with:
clarity, relevance, confidence, completeness (integer 0-100);
suggested_answer (a concise first-person answer, 2-4 sentences, grounded only in known information);
strengths (maximum 2 short strings);
improvements (maximum 3 short actionable strings).
Do not invent metrics, employers, or technologies.
"""

    def call_gemini():
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(
            prompt,
            generation_config={"temperature": 0.25, "max_output_tokens": 500},
            request_options={"timeout": GEMINI_TIMEOUT_SECONDS},
        )
        raw = response.text.strip().removeprefix("```json").removesuffix("```").strip()
        parsed = json.loads(raw)
        return {
            "clarity": int(parsed.get("clarity", fallback["clarity"])),
            "relevance": int(parsed.get("relevance", fallback["relevance"])),
            "confidence": int(parsed.get("confidence", fallback["confidence"])),
            "completeness": int(parsed.get("completeness", fallback["completeness"])),
            "suggested_answer": str(parsed.get("suggested_answer", fallback["suggested_answer"])),
            "strengths": _list_items(parsed.get("strengths"))[:2] or fallback["strengths"],
            "improvements": _list_items(parsed.get("improvements"))[:3] or fallback["improvements"],
        }

    return _run_with_timeout(call_gemini, GEMINI_TIMEOUT_SECONDS + 1, fallback)


def get_next_interview_question(
    resume_summary: dict,
    jd_text: str,
    history: list,
    duration_mode: str,
    latest_evaluation: dict | None = None,
):
    fallback = _fallback_question(resume_summary, jd_text, history, latest_evaluation)
    if not GEMINI_API_KEY:
        return fallback

    formatted_history = "\n".join(
        f"{'Interviewer' if turn.get('role') == 'ai' else 'Candidate'}: {turn.get('text', '')}"
        for turn in history[-12:]
    ) or "No questions asked yet."
    asked = _questions(history)
    prompt = f"""
Act as a professional adaptive technical interviewer.
Resume: {resume_summary}
Job description: {jd_text or "General practice interview"}
Duration mode: {duration_mode}
Conversation:
{formatted_history}
Latest answer evaluation: {latest_evaluation or "Not available"}
Questions already asked: {asked}

Ask exactly one concise next question.
- Never repeat or closely paraphrase any previous question.
- Use both the resume and the latest answer. If the candidate mentions a role interest, company motivation, AI, internship, or a technology, ask a natural follow-up that connects that mention to resume evidence.
- Ask a focused follow-up when the latest answer is incomplete, generic, or weakly relevant.
- Move to a new resume, project, technical-depth, behavioral, or role-fit topic only after the latest answer has enough detail.
- Ask for personal contribution, reasoning, trade-offs, debugging, testing, scale, or outcomes.
- Keep it under 28 words and do not dump long resume subject lists into the question.
- Do not give feedback and do not mention scores.
Return only the question.
"""

    def call_gemini():
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(
            prompt,
            generation_config={"temperature": 0.55, "max_output_tokens": 120},
            request_options={"timeout": GEMINI_TIMEOUT_SECONDS},
        )
        candidate = response.text.strip()
        return fallback if not candidate or _too_similar(candidate, asked) else candidate

    return _run_with_timeout(call_gemini, GEMINI_TIMEOUT_SECONDS + 1, fallback)
