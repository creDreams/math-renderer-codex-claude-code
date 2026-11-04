// Codex's supported native symbols (Apache-2.0; see licenses/Codex-NOTICE.txt).
export const delimiters: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  langle: '⟨', rangle: '⟩', lbrace: '{', '{': '{', rbrace: '}', '}': '}', lbrack: '[', rbrack: ']',
  vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖', '|': '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
});
export const symbols: Readonly<Record<string, string>> = Object.assign(Object.create(null), delimiters, {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', infty: '∞', partial: '∂', nabla: '∇',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', imath: 'ı', jmath: 'ȷ', prime: '′', angle: '∠', dagger: '†', ddagger: '‡',
  pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', circ: '∘', bullet: '∙', oplus: '⊕', otimes: '⊗', odot: '⊙',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', propto: '∝', sim: '∼', simeq: '≃', cong: '≅',
  lesssim: '≲', gtrsim: '≳', ll: '≪', gg: '≫', perp: '⊥', parallel: '∥', equiv: '≡', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', bigcup: '⋃', bigcap: '⋂', bigwedge: '⋀',
  setminus: '∖', emptyset: '∅', varnothing: '∅', land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬', top: '⊤', bot: '⊥',
  forall: '∀', exists: '∃', nexists: '∄', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕', Leftarrow: '⇐', impliedby: '⇐', Rightarrow: '⇒', implies: '⇒',
  Leftrightarrow: '⇔', iff: '⇔', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
});
