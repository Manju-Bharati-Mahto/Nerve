import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
// Dark theme is generated from index.css by scripts/gen-dark-css.mjs and must
// load AFTER it so its `.dark` overrides win.
import "./dark.css";

createRoot(document.getElementById("root")!).render(<App />);
