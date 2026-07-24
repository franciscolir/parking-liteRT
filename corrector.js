const DEFAULT_LETTER_CORRECTIONS = {
  '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B'
};
const DEFAULT_NUMBER_CORRECTIONS = {
  'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1',
  'Z': '2', 'S': '5', 'B': '8', 'G': '6'
};

export class Corrector {
  constructor(corrections) {
    this.letterCorrections = { ...DEFAULT_LETTER_CORRECTIONS };
    this.numberCorrections = { ...DEFAULT_NUMBER_CORRECTIONS };
    if (corrections) this._loadCorrections(corrections);
  }

  _loadCorrections(corrections) {
    if (corrections.letter && corrections.number) {
      Object.assign(this.letterCorrections, corrections.letter);
      Object.assign(this.numberCorrections, corrections.number);
      return;
    }
    for (const [from, to] of Object.entries(corrections)) {
      if (/[A-Z]/.test(from)) {
        this.numberCorrections[from] = to;
      } else if (/[0-9]/.test(from)) {
        this.letterCorrections[from] = to;
      }
    }
  }

  _detectZones(text) {
    let numCount = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (/[0-9]/.test(text[i])) numCount++;
      else break;
    }
    let leadCount = 0;
    for (let i = 0; i < text.length - numCount; i++) {
      if (/[A-Z]/.test(text[i])) leadCount++;
      else break;
    }
    return leadCount + numCount === text.length && leadCount > 0 && numCount > 0
      ? { letterRange: [0, leadCount - 1], numberRange: [leadCount, text.length - 1] }
      : null;
  }

  correct(text) {
    const clean = text.replace(/[\s-]/g, '').toUpperCase();
    const zones = this._detectZones(clean);
    if (zones) {
      return clean.split('').map((c, i) => {
        if (i >= zones.letterRange[0] && i <= zones.letterRange[1]) {
          return this.letterCorrections[c] || c;
        }
        if (i >= zones.numberRange[0] && i <= zones.numberRange[1]) {
          return this.numberCorrections[c] || c;
        }
        return c;
      }).join('');
    }
    return clean.split('').map(c => this.letterCorrections[c] || this.numberCorrections[c] || c).join('');
  }

  setCorrections(corrections) {
    this.letterCorrections = { ...DEFAULT_LETTER_CORRECTIONS };
    this.numberCorrections = { ...DEFAULT_NUMBER_CORRECTIONS };
    this._loadCorrections(corrections);
  }
}
