Drop your landing-page intro audio file here as `intro.mp3` (or `.wav`).

The LandingPage component (src/pages/LandingPage.tsx) attempts to play
`/audio/intro.mp3` the first time the user scrolls. If the file is
missing the playback attempt fails silently and the page stays
visual-only — no console errors, no UI fallback needed.

For best results pick an audio clip whose major beats line up with:
  • 0–4 s   : a build-up while dots fly in from the corners
  • 4–8 s   : a soft swell as the sphere forms
  • 8–12 s  : a chord change / hit as the sphere becomes a neuron
  • 12 s +  : a held drone behind the login form
