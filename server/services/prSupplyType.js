/**
 * Per-line PR supply type helpers.
 * Uses the existing pr_items.purchase_type and required_cut_size columns so
 * this feature does not require destructive schema changes.
 */

const SUPPLY_TYPES = Object.freeze({
  FULL: 'Full Size',
  CUT: 'Cut Size'
});

function normalizeSupplyType(value) {
  return String(value || '').trim().toLowerCase() === 'cut size'
    ? SUPPLY_TYPES.CUT
    : SUPPLY_TYPES.FULL;
}

function parseDimensionValue(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a valid positive dimension.`);
  }
  return n;
}

function isPlateSheetItem(item) {
  const text = [
    item.productName,
    item.itemDescription,
    item.materialGrade,
    item.sizeDimensions,
    item.unit
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(plate|sheet|steel plate|stainless plate|marine plate|metal sheet)\b/.test(text);
}

function encodeCutSize(length, width) {
  return JSON.stringify({
    length: String(length ?? '').trim(),
    width: String(width ?? '').trim()
  });
}

function decodeCutSize(value) {
  if (!value) return { length: '', width: '' };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object') {
      return {
        length: String(parsed.length ?? '').trim(),
        width: String(parsed.width ?? '').trim()
      };
    }
  } catch (_) {
    const parts = String(value).split(/\s*[x×]\s*/i).map(v => v.trim()).filter(Boolean);
    return { length: parts[0] || '', width: parts[1] || '' };
  }
  return { length: '', width: '' };
}

function prepareCartItems(cartItems) {
  if (!Array.isArray(cartItems)) return [];

  return cartItems.map(item => {
    const supplyType = normalizeSupplyType(item.supplyType);
    const cutLength = String(item.cutLength ?? '').trim();
    const cutWidth = String(item.cutWidth ?? '').trim();

    if (supplyType === SUPPLY_TYPES.CUT) {
      parseDimensionValue(cutLength, 'Cut Length');
      if (isPlateSheetItem(item)) {
        parseDimensionValue(cutWidth, 'Cut Width');
      } else if (cutWidth) {
        parseDimensionValue(cutWidth, 'Cut Width');
      }
    }

    return {
      ...item,
      supplyType,
      originalDimensions: item.originalDimensions || item.sizeDimensions || '',
      purchaseType: supplyType === SUPPLY_TYPES.CUT
        ? 'PROJECT-SPECIFIC CUT SIZE'
        : 'STANDARD STOCK ITEM',
      requiredCutSize: supplyType === SUPPLY_TYPES.CUT
        ? encodeCutSize(cutLength, cutWidth)
        : null
    };
  });
}

function preparePurchaseRequestBody(body) {
  const next = { ...body };
  next.purchaseType = 'STANDARD STOCK ITEM';
  next.requiredCutSize = null;
  next.cartItems = prepareCartItems(body.cartItems);
  return next;
}

module.exports = {
  SUPPLY_TYPES,
  normalizeSupplyType,
  decodeCutSize,
  prepareCartItems,
  preparePurchaseRequestBody,
  isPlateSheetItem
};
