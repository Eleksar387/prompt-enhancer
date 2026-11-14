// Shared creative-direction data for the MiniMax H3 writer (main pipeline only).
// The rules themselves now live in src/h3Prompt.js ("WHAT IS WORTH FILMING"), merged
// with the camera / dialogue / sound rules; this file keeps the banned-word list so
// there is one place to edit it. Switched by the "Creative craft rules" checkbox in
// ⚙ Backend (cfg.craftRules, default on). Off = the legacy prompt, byte for byte.

export const CRAFT_CLICHES = [
  'cinematic', 'dynamic camera', 'epic', 'stunning', 'breathtaking', 'masterpiece',
  'a sense of', 'palpable tension', 'electric atmosphere', 'time seems to slow',
  'dramatic lighting', 'slow push-in on the face (as a reflex)', 'sparks fly',
]
