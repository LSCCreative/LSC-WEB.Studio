Master Product Blueprint: Integrated Client Proofing & Delivery Hub
🏗️ Architecture: GitHub CI/CD + Bunny.net Serverless Edge Network
🎯 1. Product Vision & Site Integration
The Client Proofing & Delivery Hub is a premium, serverless extension integrated directly into your existing website ecosystem. It serves as a secure, high-speed, branded portal where your studio can upload creative media campaigns, gather frame-accurate client feedback, enforce contractual finality, and automate the safe release of master files.

By coupling your website’s GitHub repository with Bunny.net's Global Content Delivery Network (CDN), the entire platform runs completely serverless with near-zero operating costs. This infrastructure completely eliminates slow load times and third-party SaaS monthly subscriptions. It gives your studio an enterprise-grade file delivery system hidden entirely behind your own custom domain name.

🛠️ 2. The Core Infrastructure (The Bunny.net Edge Layer)
By building this directly on Bunny.net and GitHub from the start, the app's heavy lifting is handled by cloud edge routing rather than an expensive, slow database server.

Automated Git Deployment (CI/CD): The website repository is linked directly to Bunny.net. Every time a feature update or visual adjustment is pushed to GitHub, Bunny instantly mirrors the repository and updates your live site worldwide in milliseconds.

Bunny Stream (Secure Media Canvas): Video preview files are hosted natively on Bunny Stream. This creates a thief-proof review environment. Clients can stream beautiful, smooth video playbacks, but the raw media files are completely locked behind token authentication. This prevents tech-savvy clients from right-clicking and stealing unapproved cuts before formal finalization.

Bunny Storage (Local Master Payloads): Your master download links pull files straight from Bunny Storage instead of external spaces like WeTransfer. Files are distributed globally and downloaded at the maximum speed the client's internet link allows, costing only fractions of a cent per gigabyte.

Serverless Edge Scripting (Zero-Middlemen): Third-party form managers (like Web3Forms or EmailJS) are completely stripped out. When a client finishes an approval, your page shoots a secure payload to a private Bunny.net Edge Script URL. This edge token securely injects your studio's email credentials away from the client's browser, records the transaction, and executes the email delivery behind the scenes.

🚪 3. Access Control & The Entry Point
To maintain a clean, distraction-free visual aesthetic on your public homepage, access to the system is hidden inside a tiny, discreet footer link.

The Footer Gatekeeper
A tiny, low-contrast text link labeled simply as Admin or · is placed at the absolute bottom of your website’s global footer. To a regular visitor, it looks like standard styling placeholder text.

The 4-Pin Pad Gatekeeper
Clicking the footer link launches a minimalist, full-screen keypad overlay.

Access requires a 4-digit security PIN (1234).

Entering an incorrect combination instantly triggers a horizontal "shake" animation, turning the input dots red before wiping the sequence clean.

Active session tokens guarantee that if an unauthenticated user tries to skip the keypad by typing a direct back-end path into their browser, the site forces an immediate, hard redirect back to the lock screen.

🔒 4. The Admin Workspace (Page Builder & Tracker)
Once unlocked, the workspace shifts to a clean, premium slate-gray interface optimized for rapid project deployment and asset management.

The Project Setup & PDF Arena
The creator fills out the baseline project parameters: Project Name, Unique Project ID (UPID), Client CRM Info, and a Personal Message.

A drag-and-drop file upload arena allows the creator to slide a copy of the final project invoice directly into the system. This registers the PDF and pre-stages it for secure client-side embedding.

Conditional Tabs & The Link Validator
To keep the setup workspace completely clean, no asset fields are visible initially. The admin uses two action buttons: [+ Add Video] and [+ Add Photo Library].

Clicking an injector dynamically spawns an independent, self-contained data tab. Within each individual tab, the creator enters three distinct targets: the Review Asset Link (Bunny Stream), the Main Download Link (Bunny Storage), and the Google Drive Backup Link.

An active link validator traces through every dynamic tab on save, enforcing a strict https:// prefix check to catch manual data-entry typos before launch.

The Master Project Tracker & Live Mutations (R1)
All active projects are tracked in a scannable grid showing color-coded project health badges: 🟡 Reviewing, 🟠 Changes Requested, or 🟢 Approved & Closed.

Every project card holds a discreet context menu (...). Selecting "Edit Project" pulls that live project payload back into the creation form fields. The creator can dynamically overwrite URLs, adjust text strings, or add/delete media tabs on live records, updating the global database instantly upon save re-validation.

📺 5. The Client Portal (The Review Environment)
When a client visits their private link, the system swaps your website's theme to a cinema-dark mode to ensure creative media assets pop.

The Organized Media Grid
Clients land on a beautifully organized landing dashboard. Instead of loading straight into a random video timeline, the app generates structured deliverable container cards matching the exact format: View [VIDEO/PHOTO GALLERY TITLE]. This tells the client exactly what has been delivered under this campaign package.

The Tabbed Navigation Switcher
Clicking a card from the landing grid opens the active media canvas. A persistent tab header anchors to the top of the viewport, allowing clients to hop back and forth between reviewing video timelines and scrolling through photo grids natively without page reloads.

Micro-Interaction Logic Loops
Dual-Trigger Timestamp Anchor (Videos): If the client starts typing a revision note while the video is playing, the player instantly pauses and an animated timestamp pill badge (e.g., ⏱️ 01:24) slides into the corner of the input box. If they hit pause manually using the controls, the script catches that exact frame and pre-renders the timestamp pill inside the empty comment area. If they hit play without typing, the stale pill smoothly fades away.

Photo Dropdown Enforcement (Photos): For photo assets, the "Submit Revision" action remains locked and unclickable until the client selects an exact photo number from a dropdown menu, preventing vague feedback placement.

📥 6. The Approval & Secure Delivery State Machine (R2)
The client workspace is completely governed by a strict, binary interaction gateway:

The Revision State
Clicking [I want revisions for this] opens the text feedback submission area and blocks the approval pathway.

An [X Cancel Revisions] button is provided to reset the view. However, if submitted comments already exist in the activity log below the form, the cancel button is permanently disabled. Hovering over it fires an explicit tooltip: "remove revisions below to cancel and go back", protecting the stability of the review feed.

The Approval State & The Invoice Gate
Clicking [Approve content - Im ready to receive this] deploys a fullscreen, blurred modal overlay prompting a final check notice: "this will finalise this content production and you will be sent to download a copy as final handover".

Approval states are tracked independently across each dynamic asset tab. The invoice reader and final download payload are completely blocked and hidden from the DOM if even a single media asset tab is marked as unapproved or pending revisions. * The system only mounts and renders the final delivery deck when the absolute final asset tab transitions to an approved state.

📦 7. The Final Delivery Dashboard
The exact millisecond the final approval is cleared, the system executes a permanent state shift. The comment panels, timeline tools, and gateway controls are completely stripped from the page, locking the web portal into a read-only receipt view.

The Embedded Invoice Reader
The layout transforms to present a beautiful, embedded scrollable mockup view of the final PDF invoice, allowing the client to read and print their documentation natively inside your website.

Multi-Asset Dual-Route Payload Links
An announcement banner animates into view stating: "An email with a copy of the invoice and download links has been sent to your email."

The page triggers the private Bunny Edge Script to securely dispatch a complete log of the transaction to your studio and the client's inbox, tracking the execution via dynamic UI status banners (Sending 🟡 -> Sent 🟢 -> Failed 🔴).

Stroke-End Canvas Persistence: Client signatures are captured securely to local state the exact moment a stroke finishes (mouseup / touchend), ensuring subsequent re-renders or CAPTCHA toggles never accidentally wipe the legal sign-off file.

The page renders dynamic, high-contrast download pairs for every individual asset that was approved, utilizing your secure Bunny Storage CDN and a secondary Google Drive backup link:

Promo Film: [Download Content] [Google Drive Backup]

Campaign Photos: [Download Content] [Google Drive Backup]