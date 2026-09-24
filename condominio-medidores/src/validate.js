'use strict';
/** Pequenos utilitários de validação de formulários. */

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const str = (v, max = 255) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

function required(v, label, max) {
  const s = str(v, max);
  if (!s) throw new ValidationError(`Preencha o campo "${label}".`);
  return s;
}

/**
 * Converte número digitado no padrão brasileiro ("2.740,5", "498,0", "498.5").
 * Retorna null quando vazio.
 */
function parseNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function number(v, label, { requiredField = false, min = null } = {}) {
  const n = parseNumber(v);
  if (n === null) {
    if (requiredField) throw new ValidationError(`Informe o campo "${label}".`);
    return null;
  }
  if (Number.isNaN(n)) throw new ValidationError(`O valor de "${label}" não é um número válido.`);
  if (min !== null && n < min) throw new ValidationError(`O valor de "${label}" não pode ser menor que ${min}.`);
  return n;
}

function oneOf(v, allowed, label, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!allowed.includes(v)) throw new ValidationError(`Valor inválido para "${label}".`);
  return v;
}

function id(v, label = 'registro') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`Selecione o ${label}.`);
  return n;
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

module.exports = { ValidationError, str, required, parseNumber, number, oneOf, id, isEmail };
