const PLATE_FORMATS = [
  /^[A-Z]{4}[0-9]{2}$/,
  /^[A-Z]{2}[0-9]{4}$/,
  /^[A-Z]{2}-[0-9]{4}$/,
  /^[A-Z]{2}-[0-9]{2}-[0-9]{2}$/,
  /^[A-Z][0-9]{4}$/,
  /^C[DJ][0-9]{4}$/,
  /^C[DJ]-[0-9]{4}$/
];

export function validatePlate(plate) {
  return PLATE_FORMATS.some(r => r.test(plate));
}

export function normalizePlate(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
