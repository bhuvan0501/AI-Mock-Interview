import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import interviewerPortrait from './assets/ai-interviewer.png';

const API_BASE = 'http://127.0.0.1:8000';
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const initialSessionUser = (() => {
  const stored = sessionStorage.getItem('hirebyte_user');
  return stored ? JSON.parse(stored) : null;
})();

const navItems = ['Dashboard', 'AI Interview', 'ATS Checker', 'Interview History', 'Analytics'];
const navIcons = {
  Dashboard: 'D',
  'AI Interview': 'I',
  'ATS Checker': 'A',
  'Interview History': 'H',
  Analytics: 'N',
};

const durationLabels = {
  quick: 'Quick Interview',
  standard: 'Standard Interview',
  full: 'Full Interview',
};

const fallbackProfile = {
  skills: [],
  projects: [],
  technologies: [],
  education: [],
  certifications: [],
};

function getFriendlyError(error) {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return 'Backend is offline. Start FastAPI with: cd backend; ..\\venv\\Scripts\\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000';
  }
  return error.message || 'Something went wrong. Please try again.';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [String(value)];
}

function makeScore(history) {
  const evaluations = history
    .filter((turn) => turn.role === 'user' && turn.evaluation)
    .map((turn) => turn.evaluation);
  const average = (key, fallback) => evaluations.length
    ? Math.round(evaluations.reduce((sum, item) => sum + Number(item[key] || 0), 0) / evaluations.length)
    : fallback;
  return {
    overall: average('completeness', 0),
    technical: average('relevance', 0),
    communication: average('clarity', 0),
    confidence: average('confidence', 0),
  };
}

function decodeGoogleCredential(credential) {
  try {
    const payload = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(decodeURIComponent(atob(payload).split('').map(
      (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
    ).join('')));
    return {
      id: data.sub,
      name: data.name,
      email: data.email,
      picture: data.picture,
      provider: 'google',
    };
  } catch {
    return null;
  }
}

function App() {
  const [user, setUser] = useState(initialSessionUser);
  const [activePage, setActivePage] = useState('Dashboard');
  const [phase, setPhase] = useState('setup');
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState('');
  const [file, setFile] = useState(null);
  const [jdText, setJdText] = useState('');
  const [durationMode, setDurationMode] = useState('standard');
  const [structuredProfile, setStructuredProfile] = useState(null);
  const [interviewMode, setInterviewMode] = useState('Practice Interview');
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [candidateResponse, setCandidateResponse] = useState('');
  const [history, setHistory] = useState([]);
  const [savedInterviews, setSavedInterviews] = useState(() => {
    if (!initialSessionUser) return [];
    const stored = localStorage.getItem(`hirebyte_interviews_${initialSessionUser.id}`);
    return stored ? JSON.parse(stored) : [];
  });
  const [atsFile, setAtsFile] = useState(null);
  const [atsJd, setAtsJd] = useState('');
  const [atsResult, setAtsResult] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [pendingNavigation, setPendingNavigation] = useState(null);

  const videoRef = useRef(null);
  const recognitionRef = useRef(null);
  const transcriptBaseRef = useRef('');

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(`hirebyte_interviews_${user.id}`, JSON.stringify(savedInterviews));
  }, [savedInterviews, user]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.lang = 'en-IN';
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.onresult = (event) => {
      const finalParts = [];
      const interimParts = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternatives = Array.from(result);
        const best = alternatives.find((item) => /bhuvan|bhuvan/i.test(item.transcript))
          || alternatives.sort((a, b) => b.confidence - a.confidence)[0]
          || result[0];
        const transcript = best.transcript.trim();
        if (result.isFinal) finalParts.push(transcript);
        else interimParts.push(transcript);
      }
      if (finalParts.length) {
        const nextFinal = finalParts.join(' ').replace(/\s+/g, ' ').trim();
        const previous = transcriptBaseRef.current;
        transcriptBaseRef.current = previous && nextFinal.toLowerCase().startsWith(previous.toLowerCase())
          ? nextFinal
          : `${previous} ${nextFinal}`.replace(/\s+/g, ' ').trim();
      }
      setCandidateResponse(`${transcriptBaseRef.current} ${interimParts.join(' ')}`.replace(/\s+/g, ' ').trim());
    };
    recognitionRef.current = recognition;
  }, []);

  useEffect(() => {
    if (videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
      videoRef.current.play().catch(() => {
        setCameraError('Camera stream is available, but playback was blocked. Click Retry Camera.');
      });
    }
  }, [activePage, cameraStream, cameraEnabled, phase]);

  const latestScores = useMemo(() => {
    if (!savedInterviews.length) return { overall: 0, technical: 0, communication: 0, confidence: 0 };
    return savedInterviews[0].scores;
  }, [savedInterviews]);

  const averageScore = useMemo(() => {
    if (!savedInterviews.length) return 0;
    return Math.round(savedInterviews.reduce((sum, item) => sum + item.scores.overall, 0) / savedInterviews.length);
  }, [savedInterviews]);

  const profile = structuredProfile || fallbackProfile;

  function handleLogin(nextUser) {
    if (!nextUser) return;
    sessionStorage.setItem('hirebyte_user', JSON.stringify(nextUser));
    const stored = localStorage.getItem(`hirebyte_interviews_${nextUser.id}`);
    setSavedInterviews(stored ? JSON.parse(stored) : []);
    setUser(nextUser);
  }

  function signOut() {
    stopListening();
    if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
    sessionStorage.removeItem('hirebyte_user');
    setUser(null);
    setSavedInterviews([]);
    resetInterview();
  }

  async function uploadResume(targetFile, targetJd = jdText) {
    setApiError('');
    const formData = new FormData();
    formData.append('file', targetFile);
    if (targetJd.trim()) formData.append('jd_text', targetJd);

    let response;
    try {
      response = await fetch(`${API_BASE}/upload_resume/`, { method: 'POST', body: formData });
    } catch (error) {
      throw new Error(getFriendlyError(error), { cause: error });
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Resume analysis failed.');
    return data;
  }

  function resetInterview() {
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraEnabled(false);
    setCameraError('');
    setPhase('setup');
    setFile(null);
    setJdText('');
    setStructuredProfile(null);
    setInterviewMode('Practice Interview');
    setCurrentQuestion('');
    setCandidateResponse('');
    transcriptBaseRef.current = '';
    setHistory([]);
    setApiError('');
    setActivePage('AI Interview');
  }

  function navigateTo(page) {
    if (phase === 'interview' && activePage === 'AI Interview' && page !== 'AI Interview') {
      setPendingNavigation(page);
      return;
    }
    if (page === 'AI Interview' && phase === 'results') {
      resetInterview();
      return;
    }
    setActivePage(page);
  }

  function closeInterviewAndNavigate(page) {
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraEnabled(false);
    setCameraError('');
    setPhase('setup');
    setCurrentQuestion('');
    setCandidateResponse('');
    transcriptBaseRef.current = '';
    setHistory([]);
    setPendingNavigation(null);
    setActivePage(page);
  }

  async function requestNextQuestion(nextHistory, latestEvaluation = null) {
    setApiError('');
    let response;
    try {
      response = await fetch(`${API_BASE}/interview/next-question/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structured_profile: profile,
          jd_text: jdText,
          history: nextHistory,
          duration_mode: durationMode,
          latest_evaluation: latestEvaluation,
        }),
      });
    } catch (error) {
      throw new Error(getFriendlyError(error), { cause: error });
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Question generation failed.');
    return data.next_question;
  }

  async function handleAnalyzeResume(event) {
    event.preventDefault();
    if (!file) return alert('Please upload a PDF or DOCX resume first.');

    setLoading(true);
    setHistory([]);
    setCurrentQuestion('');
    setCandidateResponse('');
    try {
      const data = await uploadResume(file);
      setStructuredProfile(data.structured_profile || fallbackProfile);
      setInterviewMode(data.interview_mode || 'Practice Interview');
      setPhase('preview');
      setActivePage('AI Interview');
    } catch (error) {
      setApiError(getFriendlyError(error));
    } finally {
      setLoading(false);
    }
  }

  async function startInterview() {
    setLoading(true);
    try {
      const question = await requestNextQuestion([]);
      setCurrentQuestion(question);
      setHistory([]);
      setCandidateResponse('');
      setPhase('interview');
      speak(question);
      await startCamera();
    } catch (error) {
      setApiError(getFriendlyError(error));
    } finally {
      setLoading(false);
    }
  }

  async function startCamera() {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraEnabled(false);
      setCameraError('Camera access is not supported in this browser. Use Chrome or Edge on http://127.0.0.1:5175.');
      return;
    }
    try {
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some((device) => device.kind === 'videoinput');
      if (!hasCamera) {
        setCameraStream(null);
        setCameraEnabled(false);
        setCameraError('No webcam was detected on this device. You can continue the interview with voice/text, or connect/enable a camera and retry.');
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (error) {
        if (error.name !== 'OverconstrainedError' && error.name !== 'ConstraintNotSatisfiedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      setCameraStream(stream);
      setCameraEnabled(true);
    } catch (error) {
      setCameraStream(null);
      setCameraEnabled(false);
      setCameraError(
        error.name === 'NotAllowedError'
          ? 'Camera permission is blocked. Allow camera access from the browser address bar, then click Retry Camera.'
          : error.name === 'NotFoundError'
            ? 'No webcam was detected. Connect or enable a camera, close other apps using it, then click Retry Camera.'
          : `Camera could not start (${error.name || 'unknown error'}). Close other apps using the webcam, then retry.`,
      );
    }
  }

  async function submitAnswer(event) {
    event.preventDefault();
    if (!candidateResponse.trim()) return alert('Please speak or type your answer before submitting.');

    stopListening();
    const submittedAnswer = candidateResponse.trim();

    const answerCount = history.filter((turn) => turn.role === 'user').length + 1;
    const maxQuestions = durationMode === 'quick' ? 4 : durationMode === 'standard' ? 8 : 12;

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/interview/evaluate-answer/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structured_profile: profile,
          jd_text: jdText,
          history,
          duration_mode: durationMode,
          question: currentQuestion,
          answer: submittedAnswer,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Answer evaluation failed.');
      const nextHistory = [
        ...history,
        { role: 'ai', text: currentQuestion },
        { role: 'user', text: submittedAnswer, evaluation: data.evaluation },
      ];
      setHistory(nextHistory);
      setCandidateResponse('');
      transcriptBaseRef.current = '';
      if (answerCount >= maxQuestions) {
        finishInterview(nextHistory);
        return;
      }
      setCurrentQuestion(data.next_question);
      speak(data.next_question);
    } catch (error) {
      setCandidateResponse(submittedAnswer);
      transcriptBaseRef.current = submittedAnswer;
      setApiError(getFriendlyError(error));
    } finally {
      setLoading(false);
    }
  }

  function finishInterview(finalHistory = history) {
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraEnabled(false);
    setCameraError('');

    const scores = makeScore(finalHistory);
    const evaluations = finalHistory.filter((turn) => turn.role === 'user' && turn.evaluation);
    const strengths = [...new Set(evaluations.flatMap((turn) => turn.evaluation.strengths || []))].slice(0, 4);
    const improvements = [...new Set(evaluations.flatMap((turn) => turn.evaluation.improvements || []))].slice(0, 4);
    const session = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      date: new Date().toLocaleString(),
      type: interviewMode,
      duration: durationLabels[durationMode],
      scores,
      profile,
      transcript: finalHistory,
      feedback: {
        strengths: strengths.length ? strengths : ['You completed the interview and addressed each question.'],
        improvements: improvements.length ? improvements : ['Use specific examples and measurable outcomes.'],
      },
    };
    setSavedInterviews((items) => [session, ...items]);
    setPhase('results');
    setActivePage('Analytics');
  }

  async function runAtsCheck(event) {
    event.preventDefault();
    if (!atsFile) return alert('Upload a resume to check ATS compatibility.');

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', atsFile);
      if (atsJd.trim()) formData.append('jd_text', atsJd);
      const response = await fetch(`${API_BASE}/ats/analyze/`, { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'ATS analysis failed.');
      setAtsResult({
        score: data.score,
        missingKeywords: data.missing_keywords || [],
        matchedKeywords: data.matched_keywords || [],
        tips: data.tips || [],
        documentStats: data.document_stats || {},
        profile: data.structured_profile || fallbackProfile,
        filename: data.filename,
      });
    } catch (error) {
      setApiError(getFriendlyError(error));
    } finally {
      setLoading(false);
    }
  }

  function speak(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /natural|zira|samantha|aria|female/i.test(voice.name) && /^en/i.test(voice.lang))
      || voices.find((voice) => /^en-(IN|GB|US)/i.test(voice.lang))
      || null;
    utterance.rate = 0.87;
    utterance.pitch = 1.06;
    utterance.volume = 0.88;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  function toggleListening() {
    if (!recognitionRef.current) {
      alert('Speech recognition is supported best in Chrome or Edge.');
      return;
    }
    if (isListening) stopListening();
    else {
      transcriptBaseRef.current = candidateResponse.trim();
      recognitionRef.current.start();
    }
  }

  function stopListening() {
    if (recognitionRef.current && isListening) recognitionRef.current.stop();
    setIsListening(false);
  }

  if (!user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  const activeInterviewRoom = activePage === 'AI Interview' && phase === 'interview';
  const shellClass = [
    'app-shell',
    activePage === 'Dashboard' ? 'is-dashboard' : '',
    activeInterviewRoom ? 'is-live-interview' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <Header activePage={activePage} setActivePage={navigateTo} user={user} onSignOut={signOut} compact={activeInterviewRoom} />
      {loading && <div className="loading-panel">Analyzing with AI...</div>}

      <main className="page-wrap">
        {apiError && (
          <div className="system-alert" role="status">
            <div>
              <strong>Connection check needed</strong>
              <p>{apiError}</p>
            </div>
            <button type="button" onClick={() => setApiError('')}>Dismiss</button>
          </div>
        )}

        {activePage === 'Dashboard' && (
          <Dashboard
            user={user}
            averageScore={averageScore}
            latestScores={latestScores}
            totalInterviews={savedInterviews.length}
            setActivePage={setActivePage}
          />
        )}

        {activePage === 'AI Interview' && (
          <InterviewPage
            phase={phase}
            file={file}
            setFile={setFile}
            jdText={jdText}
            setJdText={setJdText}
            durationMode={durationMode}
            setDurationMode={setDurationMode}
            profile={profile}
            interviewMode={interviewMode}
            currentQuestion={currentQuestion}
            candidateResponse={candidateResponse}
            setCandidateResponse={setCandidateResponse}
            isListening={isListening}
            isSpeaking={isSpeaking}
            cameraEnabled={cameraEnabled}
            cameraError={cameraError}
            videoRef={videoRef}
            onAnalyze={handleAnalyzeResume}
            onStart={startInterview}
            onSubmit={submitAnswer}
            onToggleListening={toggleListening}
            onFinish={() => finishInterview(history)}
            onSpeakAgain={() => speak(currentQuestion)}
            onRetryCamera={startCamera}
            interviewerPortrait={interviewerPortrait}
          />
        )}

        {activePage === 'ATS Checker' && (
          <AtsChecker
            atsFile={atsFile}
            setAtsFile={(nextFile) => {
              setAtsFile(nextFile);
              setAtsResult(null);
            }}
            atsJd={atsJd}
            setAtsJd={(nextJd) => {
              setAtsJd(nextJd);
              setAtsResult(null);
            }}
            atsResult={atsResult}
            onRun={runAtsCheck}
          />
        )}

        {activePage === 'Interview History' && <HistoryPage interviews={savedInterviews} />}

        {activePage === 'Analytics' && (
          <AnalyticsPage scores={latestScores} interviews={savedInterviews} phase={phase} onNewInterview={resetInterview} />
        )}
      </main>

      {pendingNavigation && (
        <div className="confirm-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="interview-nav-title">
            <span>Interview in progress</span>
            <h2 id="interview-nav-title">Do you want to continue or close this interview?</h2>
            <p>Your current question, typed answer, webcam, and microphone session are still active.</p>
            <div className="confirm-actions">
              <button className="secondary-btn" type="button" onClick={() => setPendingNavigation(null)}>Continue Interview</button>
              <button className="danger-btn" type="button" onClick={() => closeInterviewAndNavigate(pendingNavigation)}>Close Interview</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const googleButtonRef = useRef(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleError, setGoogleError] = useState(
    GOOGLE_CLIENT_ID ? '' : 'Add VITE_GOOGLE_CLIENT_ID to frontend/.env, then restart the Vite frontend server.',
  );

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return undefined;
    const setupGoogle = () => {
      if (!window.google?.accounts?.id || !googleButtonRef.current) return false;
      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: ({ credential }) => {
            const googleUser = credential ? decodeGoogleCredential(credential) : null;
            if (!googleUser) {
              setGoogleError('Google sign-in did not return a valid account. Check the OAuth client origin and try again.');
              return;
            }
            setGoogleError('');
            onLogin(googleUser);
          },
        });
        googleButtonRef.current.replaceChildren();
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'signin_with',
          width: 300,
        });
        setGoogleReady(true);
        setGoogleError('');
        return true;
      } catch (error) {
        setGoogleError(`${error.message || 'Google sign-in failed.'} Make sure http://127.0.0.1:5175 is added as an authorized JavaScript origin.`);
        return false;
      }
    };
    if (setupGoogle()) return undefined;
    const timer = window.setInterval(() => {
      if (setupGoogle()) window.clearInterval(timer);
    }, 250);
    const timeout = window.setTimeout(() => {
      if (!window.google?.accounts?.id) {
        setGoogleError('Google sign-in script did not load. Check your internet connection, then refresh this page.');
      }
    }, 5000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [onLogin]);

  return (
    <main className="login-shell">
      <section className="login-panel">
        <span className="brand-mark">H</span>
        <p className="eyebrow">HIREBYTE AI</p>
        <h1>Login</h1>
        <p>Continue with your Google account to open your interview workspace.</p>
        {GOOGLE_CLIENT_ID && <div ref={googleButtonRef} className="google-button" />}
        {googleError && <p className="auth-error">{googleError}</p>}
        {!googleReady && (
          <button
            className="primary-btn full"
            type="button"
            onClick={() => onLogin({ id: 'local-demo', name: 'Local Student', email: 'Private local mode', provider: 'local' })}
          >
            Continue in Private Local Mode
          </button>
        )}
        <p className="login-note">Your history, ATS checks, and analytics stay separated by account on this device.</p>
      </section>
    </main>
  );
}

function Header({ activePage, setActivePage, user, onSignOut, compact = false }) {
  return (
    <header className={compact ? 'topbar compact' : 'topbar'}>
      <button className="brand" onClick={() => setActivePage('Dashboard')} type="button">
        <span className="brand-mark">H</span>
        <span>
          <strong>HIREBYTE AI</strong>
          <small>Interview cockpit</small>
        </span>
      </button>

      <nav className="nav-pills" aria-label="Main navigation">
        {navItems.map((item) => (
          <button
            key={item}
            type="button"
            className={activePage === item ? 'active' : ''}
            onClick={() => setActivePage(item)}
            title={item}
          >
            <span className="nav-icon">{navIcons[item]}</span>
            <span className="nav-label">{item}</span>
          </button>
        ))}
      </nav>
      <div className="account-panel">
        {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : <span>{user.name?.[0] || 'U'}</span>}
        <div><strong>{user.name}</strong><small>{user.email}</small></div>
        <button type="button" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

function Dashboard({ user, averageScore, latestScores, totalInterviews, setActivePage }) {
  const timestamp = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());
  const firstName = user?.name?.split(' ')[0] || 'Student';

  return (
    <section className="dashboard-grid">
      <div className="dashboard-greeting">
        <div>
          <h1>Hello, {firstName}</h1>
          <p>{timestamp}</p>
        </div>
        <button className="primary-btn" type="button" onClick={() => setActivePage('AI Interview')}>New Interview</button>
      </div>

      <div className="hero-panel">
        <p className="status-chip"><span /> Adaptive engine ready</p>
        <h2>Practice makes perfect</h2>
        <p>
          HireByte adapts questions to your resume, target role, and previous answers in real time.
        </p>
        <div className="hero-actions">
          <button className="primary-btn" type="button" onClick={() => setActivePage('AI Interview')}>Start AI Interview</button>
          <button className="secondary-btn" type="button" onClick={() => setActivePage('ATS Checker')}>Check Resume ATS</button>
        </div>
      </div>

      <div className="metric-card dark">
        <span>Overall Score</span>
        <strong>{averageScore || '--'}/100</strong>
        <small>{totalInterviews ? 'Average across saved sessions' : 'Complete an interview to unlock'}</small>
      </div>
      <div className="metric-card">
        <span>Total Interviews</span>
        <strong>{totalInterviews}</strong>
        <small>Practice and company-specific attempts</small>
      </div>
      <div className="metric-card teal">
        <span>Latest Communication</span>
        <strong>{latestScores.communication || '--'}</strong>
        <small>Clarity, structure, and grammar</small>
      </div>

      <div className="metric-card action-card">
        <span>ATS Readiness</span>
        <strong>{latestScores.technical || '--'}</strong>
        <small>Resume match and technical relevance</small>
      </div>

      <div className="dashboard-tile">
        <span>Interview Exam Prep</span>
        <strong>Mock coaching matched to your resume.</strong>
        <button type="button" onClick={() => setActivePage('AI Interview')}>Start</button>
      </div>
      <div className="dashboard-tile">
        <span>Create ATS Resume</span>
        <strong>Check keywords before applying.</strong>
        <button type="button" onClick={() => setActivePage('ATS Checker')}>Analyze</button>
      </div>
    </section>
  );
}

function InterviewPage({
  phase,
  file,
  setFile,
  jdText,
  setJdText,
  durationMode,
  setDurationMode,
  profile,
  interviewMode,
  currentQuestion,
  candidateResponse,
  setCandidateResponse,
  isListening,
  isSpeaking,
  cameraEnabled,
  cameraError,
  videoRef,
  onAnalyze,
  onStart,
  onSubmit,
  onToggleListening,
  onFinish,
  onSpeakAgain,
  onRetryCamera,
  interviewerPortrait,
}) {
  if (phase === 'setup') {
    return (
      <section className="interview-setup">
        <div className="section-heading">
          <span>AI Interview</span>
          <h1>Configure your adaptive interview</h1>
          <p>Choose practice mode with only a resume, or company-specific mode by adding a job description.</p>
        </div>

        <form className="setup-form" onSubmit={onAnalyze}>
          <label className="upload-box">
            <span>Upload Resume</span>
            <strong>{file ? file.name : 'PDF or DOCX resume'}</strong>
            <input type="file" accept=".pdf,.docx" onChange={(event) => setFile(event.target.files[0])} />
          </label>

          <label className="field-block">
            <span>Job Description (optional)</span>
            <textarea
              value={jdText}
              onChange={(event) => setJdText(event.target.value)}
              placeholder="Paste target job description for a company-specific interview."
            />
          </label>

          <div className="duration-grid">
            {Object.entries(durationLabels).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={durationMode === value ? 'selected' : ''}
                onClick={() => setDurationMode(value)}
              >
                <strong>{label}</strong>
                <span>{value === 'quick' ? '5 min' : value === 'standard' ? '10-15 min' : '20+ min'}</span>
              </button>
            ))}
          </div>

          <button className="primary-btn full" type="submit">Analyze Resume and Preview</button>
        </form>
      </section>
    );
  }

  if (phase === 'preview') {
    return (
      <section className="preview-layout">
        <div className="section-heading">
          <span>{interviewMode}</span>
          <h1>Resume data preview</h1>
          <p>Review the extracted skills, projects, technologies, education, and certifications before starting.</p>
        </div>
        <ProfilePreview profile={profile} />
        <button className="primary-btn" type="button" onClick={onStart}>Start Interview</button>
      </section>
    );
  }

  if (phase === 'results') {
    return (
      <section className="empty-state">
        This interview is complete. Open Analytics for feedback or start a fresh interview.
      </section>
    );
  }

  return (
    <section className="interview-room">
      <div className="camera-panel">
        {cameraEnabled ? (
          <video ref={videoRef} autoPlay playsInline muted />
        ) : (
          <div className="camera-empty">
            <strong>{cameraError ? 'Camera unavailable' : 'Camera preview'}</strong>
            <p>{cameraError || 'Allow camera access to show your webcam here. You can still continue with voice or typed answers.'}</p>
            <button className="secondary-btn compact" type="button" onClick={onRetryCamera}>Retry Camera</button>
          </div>
        )}
        <span>Candidate Webcam</span>
        <div className={`avatar-panel ${isSpeaking ? 'speaking' : ''}`}>
          <div className="avatar-photo">
            <img src={interviewerPortrait} alt="AI interviewer" />
            <span className="speech-indicator"><i /><i /><i /></span>
          </div>
          <strong>Maya, AI Interviewer</strong>
          <small>{isSpeaking ? 'Asking your next question' : 'Listening carefully'}</small>
        </div>
      </div>

      <div className="interview-controls">
        <div className="question-panel">
          <div>
            <span>Current Question</span>
            <h2>{currentQuestion}</h2>
          </div>
          <button className="secondary-btn compact" type="button" onClick={onSpeakAgain}>Replay Voice</button>
        </div>

        <form className="answer-panel" onSubmit={onSubmit}>
          <div className="wave-strip">
            <span className={isListening ? 'live-dot active' : 'live-dot'} />
            <strong>{isListening ? 'Recording answer' : 'Microphone ready'}</strong>
            <div className={isListening ? 'wave active' : 'wave'}>
              {Array.from({ length: 28 }).map((_, index) => <i key={index} />)}
            </div>
          </div>
          <textarea
            value={candidateResponse}
            onChange={(event) => setCandidateResponse(event.target.value)}
            placeholder="Speak or type your answer here."
          />
          <div className="answer-actions">
            <button className={isListening ? 'danger-btn' : 'secondary-btn'} type="button" onClick={onToggleListening}>
              {isListening ? 'Stop Mic' : 'Use Mic'}
            </button>
            <button className="primary-btn" type="submit">Submit Answer</button>
            <button className="ghost-btn" type="button" onClick={onFinish}>End Interview</button>
          </div>
        </form>
      </div>
    </section>
  );
}

function ProfilePreview({ profile }) {
  const sections = ['skills', 'projects', 'technologies', 'education', 'certifications'];
  return (
    <div className="profile-grid">
      {sections.map((section) => (
        <div className="profile-card" key={section}>
          <span>{section}</span>
          {normalizeList(profile[section]).length ? (
            <ul>
              {normalizeList(profile[section]).slice(0, 6).map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          ) : (
            <p>No {section} detected yet.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function AtsChecker({ atsFile, setAtsFile, atsJd, setAtsJd, atsResult, onRun }) {
  return (
    <section className="ats-layout">
      <div className="section-heading">
        <span>ATS Checker</span>
        <h1>Advanced resume match analysis</h1>
        <p>Upload a resume and optionally paste a JD to identify missing keywords, skills, formatting fixes, and resume tips.</p>
      </div>

      <form className="setup-form" onSubmit={onRun}>
        <label className="upload-box">
          <span>Resume File</span>
          <strong>{atsFile ? atsFile.name : 'PDF or DOCX resume'}</strong>
          <input type="file" accept=".pdf,.docx" onChange={(event) => setAtsFile(event.target.files[0])} />
        </label>
        <label className="field-block">
          <span>Job Description (optional)</span>
          <textarea value={atsJd} onChange={(event) => setAtsJd(event.target.value)} placeholder="Paste the target JD for keyword matching." />
        </label>
        <button className="primary-btn full" type="submit">Analyze ATS Score</button>
      </form>

      {atsResult && (
        <div className="ats-result">
          <div className="score-ring"><strong>{atsResult.score}</strong><span>ATS Score</span></div>
          <div>
            <p><strong>{atsResult.filename}</strong> - {atsResult.documentStats.word_count || 0} parsed words</p>
            <h2>Matched Keywords</h2>
            <div className="tag-row">
              {(atsResult.matchedKeywords.length ? atsResult.matchedKeywords : ['Add a job description to compare keywords']).map((item) => <span key={item}>{item}</span>)}
            </div>
            <h2>Missing Keywords</h2>
            <div className="tag-row">
              {(atsResult.missingKeywords.length ? atsResult.missingKeywords : ['No major missing keyword found']).map((item) => <span key={item}>{item}</span>)}
            </div>
            <h2>Resume Improvement Tips</h2>
            <ul>{atsResult.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryPage({ interviews }) {
  return (
    <section className="history-layout">
      <div className="section-heading">
        <span>Interview History</span>
        <h1>Saved interview attempts</h1>
      </div>
      {interviews.length ? interviews.map((item) => (
        <article className="history-card" key={item.id}>
          <div>
            <span>{item.date}</span>
            <h2>{item.type}</h2>
            <p>{item.duration} - {item.transcript.filter((turn) => turn.role === 'user').length} answered questions</p>
          </div>
          <strong>{item.scores.overall}/100</strong>
          <details>
            <summary>View transcript</summary>
            {item.transcript.map((turn, index) => (
              <div className="history-turn" key={index}>
                <p><b>{turn.role === 'ai' ? 'AI' : 'You'}:</b> {turn.text}</p>
                {turn.evaluation && (
                  <div className="answer-score-row">
                    <span>Clarity {turn.evaluation.clarity}</span>
                    <span>Relevance {turn.evaluation.relevance}</span>
                    <span>Confidence {turn.evaluation.confidence}</span>
                  </div>
                )}
              </div>
            ))}
          </details>
        </article>
      )) : <div className="empty-state">No interview history yet. Complete an AI interview to save your first transcript.</div>}
    </section>
  );
}

function AnalyticsPage({ scores, interviews, phase, onNewInterview }) {
  const latest = interviews[0];
  return (
    <section className="analytics-layout">
      <div className="section-heading">
        <span>Analytics</span>
        <h1>{phase === 'results' ? 'Interview feedback ready' : 'Performance analytics'}</h1>
        {phase === 'results' && <button className="primary-btn" type="button" onClick={onNewInterview}>Start New Interview</button>}
      </div>
      <div className="score-grid">
        {[
          ['Overall Score', scores.overall],
          ['Technical Score', scores.technical],
          ['Communication Score', scores.communication],
          ['Confidence Score', scores.confidence],
        ].map(([label, value]) => (
          <div className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{value || '--'}</strong>
            <small>Out of 100</small>
          </div>
        ))}
      </div>

      <div className="feedback-grid">
        <div className="wide-panel">
          <h2>Strengths</h2>
          <ul>{(latest?.feedback.strengths || ['Complete an interview to generate strengths.']).map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div className="wide-panel">
          <h2>Areas For Improvement</h2>
          <ul>{(latest?.feedback.improvements || ['Complete an interview to generate improvement points.']).map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      {latest && (
        <div className="answer-review-list">
          <div className="section-heading">
            <span>Answer Review</span>
            <h2>Question-by-question coaching</h2>
          </div>
          {latest.transcript.reduce((rows, turn, index, transcript) => {
            if (turn.role !== 'user' || !turn.evaluation) return rows;
            const question = [...transcript.slice(0, index)].reverse().find((item) => item.role === 'ai');
            rows.push(
              <article className="answer-review" key={`${latest.id}-${index}`}>
                <p className="review-question">{question?.text}</p>
                <p className="review-answer"><strong>Your answer:</strong> {turn.text}</p>
                <div className="answer-score-row">
                  <span>Clarity <b>{turn.evaluation.clarity}</b></span>
                  <span>Relevance <b>{turn.evaluation.relevance}</b></span>
                  <span>Confidence <b>{turn.evaluation.confidence}</b></span>
                </div>
                <div className="suggested-answer">
                  <span>How you could answer it</span>
                  <p>{turn.evaluation.suggested_answer}</p>
                </div>
              </article>,
            );
            return rows;
          }, [])}
        </div>
      )}
    </section>
  );
}

export default App;
