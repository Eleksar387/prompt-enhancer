// Per-model prompt profiles. A profile name selects a prompt/output-repair variant
// tuned to one family of writer models; null = the normal prompt for everything else.
//
// 'compact': small local writers (24B-class, heavily quantised) that can't follow the
// full MiniMax H3 prompt — they lose the section order, leak labels and invent
// markers. Matched by substring because a llama.cpp model id is a file path.
export function h3ProfileFor(model) {
  return /cydonia/i.test(model || '') ? 'compact' : null
}
