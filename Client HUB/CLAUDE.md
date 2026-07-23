# Project Rules & Style Guide - Client HUB

## 🚀 Tech Stack
- **Frontend Core:** Vanilla JavaScript (ES6+), HTML5 Canvas, Tailwind CSS (via CDN).
- **Hosting & Infrastructure:** Bunny.net Edge Network (Continuous Deployment hooked to GitHub).
- **Media & Delivery Engine:** Bunny Stream (Token-authorized streaming) & Bunny Storage (High-speed master file CDN storage).
- **Serverless Automation:** Bunny.net Edge Scripts (for secure email payload handling without backend servers).

## 🛠️ Build & Test Commands
- **Install / Setup:** No npm compilation required.
- **Local Dev Server:** `python3 -m http.server 8000` or `npx serve .` inside the project root.
- **Syntax & Parse Check:** `node -e "new Function(fs.readFileSync('index.html', 'utf8'))"` (Verifies JS integrity before git push).

## 📐 Code Style & Architecture
- **Website Extension Isolation:** Keep all app code, states, and styles strictly encapsulated. Do not bleed code out into the parent website files, except for the tiny, hidden admin gateway link in the global footer.
- **Source of Truth:** Treat the existing unbundled `index.html` layout as the absolute blueprint for visual themes, Tailwind tokens, and DOM states.
- **Clean Configuration:** Keep all infrastructure settings, Bunny endpoints, and webhook toggles organized inside a transparent configuration block at the absolute top of the main script.

## 🚫 Output Constraints (Token Savers)
- **Delta-Only Code Output:** Never rewrite the entire 1,000+ line file for minor changes. Output modifications using highly precise code blocks, functional diffs, or surgical segment updates.
- **No Lecture text:** Do not explain obvious architectural behaviors or standard JavaScript native features. Keep text explanations direct, scannable, and minimal.