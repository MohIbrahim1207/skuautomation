/**
 * numberUtils.js
 * Helpers for Indonesian number format parsing, currency handling, and placeholder normalization.
 */

function isTextPlaceholder(val) {
  if (val === undefined || val === null) return true;
  const s = String(val).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  return lower === '-' || lower === '—' || lower === '–' || lower === 'n/a';
}

function isNumericPlaceholder(val) {
  if (val === undefined || val === null) return true;
  const s = String(val).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  return ['-', '—', '–', 'n/a', 'none', 'nil', 'null'].includes(lower);
}

function parseIndonesianNumber(val, isCurrency = false) {
  if (val === undefined || val === null) {
    return { value: null, isValid: true };
  }
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val) || val < 0) {
      return { value: null, isValid: false };
    }
    return { value: val, isValid: true };
  }

  let s = String(val).trim();
  if (isNumericPlaceholder(s)) {
    return { value: null, isValid: true };
  }

  // Strip currency prefixes e.g. "IDR", "Rp", "Rp.", and suffixes like ",-"
  s = s.replace(/^(idr|rp\.?)\s*/i, '').replace(/[,-]\s*$/, '').trim();
  if (isNumericPlaceholder(s)) {
    return { value: null, isValid: true };
  }

  // Check for illegal non-numeric characters (allow digits, dots, commas, spaces)
  if (/[^0-9.,\s]/.test(s)) {
    return { value: null, isValid: false, raw: s };
  }

  // Remove whitespace
  s = s.replace(/\s+/g, '');

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot < lastComma) {
      // 1.250.000,50 -> Indonesian/European (dots are thousands, comma is decimal)
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,250,000.50 -> US standard (commas are thousands, dot is decimal)
      s = s.replace(/,/g, '');
    }
  } else if (hasDot && !hasComma) {
    // Only dots present
    if (s.startsWith('0.') || s.startsWith('-0.')) {
      // Numbers starting with 0. are always decimal fractions e.g. 0.085, 0.5, 0.75
    } else if (!isCurrency) {
      // For weights and dimensions, multiple dots means thousand separators e.g. 1.250.000
      const dotCount = (s.match(/\./g) || []).length;
      if (dotCount > 1) {
        s = s.replace(/\./g, '');
      }
      // Single dot in weight/dimensions is standard decimal e.g. 0.085, 96.42, 1.25
    } else {
      // isCurrency: Indonesian currency uses dots as thousands separators e.g. 1.250.000 or 250.000
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
        s = s.replace(/\./g, '');
      }
    }
  } else if (hasComma && !hasDot) {
    // Only comma present
    if (isCurrency && /^\d{1,3}(,\d{3})+$/.test(s)) {
      // Keep thousand-separator logic for currency fields only e.g. 1,250,000 or 1,250
      s = s.replace(/,/g, '');
    } else {
      // For weight and dimensions (!isCurrency), treat "1,250" as decimal 1.25 (Indonesian style), not 1250
      // Also for currency with decimal comma e.g. 100,50
      s = s.replace(',', '.');
    }
  }

  const num = Number(s);
  if (isNaN(num) || !isFinite(num) || num < 0) {
    return { value: null, isValid: false, raw: s };
  }
  return { value: num, isValid: true };
}

function normalizeTextForMatching(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/mm\^2|mm²/gi, 'mm2')
    .replace(/\s+/g, ' ');
}

function getItemMatchKey(productName, itemDescription) {
  const normName = normalizeTextForMatching(productName);
  const normDesc = normalizeTextForMatching(itemDescription);
  return `${normName}|||${normDesc}`;
}

module.exports = {
  isTextPlaceholder,
  isNumericPlaceholder,
  parseIndonesianNumber,
  normalizeTextForMatching,
  getItemMatchKey
};
