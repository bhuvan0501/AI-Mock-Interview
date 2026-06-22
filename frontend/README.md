# HireByte AI Frontend

Run the frontend:

```powershell
npm run dev -- --host=127.0.0.1 --port=5175
```

Open `http://127.0.0.1:5175/`.

## Google Sign-In

1. Create an OAuth 2.0 Web Client in Google Cloud Console.
2. Add `http://127.0.0.1:5175` and `http://localhost:5175` as authorized JavaScript origins.
3. Copy `.env.example` to `.env`.
4. Set `VITE_GOOGLE_CLIENT_ID` to the Web Client ID.
5. Restart Vite.

Without a client ID, the app provides private local mode for development. Interview history is stored under a separate browser-storage key for each signed-in user.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
