# AI Mock Interview

AI-powered mock interview workspace with resume analysis, adaptive interview questions, ATS checking, interview history, analytics, voice input, webcam preview, and Google sign-in.

## Run Locally

Start both servers from the project root:

```powershell
.\start-dev.bat
```

Frontend:

```powershell
cd frontend
npx.cmd vite --host=127.0.0.1 --port=5175
```

Backend:

```powershell
cd backend
..\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:5175/
```

## Environment

Create `frontend/.env` from `frontend/.env.example` and set:

```text
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
```

Optional backend AI key:

```text
GEMINI_API_KEY=your-gemini-api-key
```

Do not commit `.env` files.
