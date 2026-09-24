// Estado compartilhado da aplicação (usuário logado, configurações, condomínios).
import { api } from './api.js';
import { pref } from './util.js';

export const state = {
  user: null,
  meta: null,
  condos: null,
};

export const isAdmin = () => state.user && state.user.role === 'admin';

export async function loadMeta() {
  state.meta = await api.get('/api/meta');
  return state.meta;
}

export async function getCondos(force = false) {
  if (!state.condos || force) state.condos = await api.get('/api/condominiums');
  return state.condos;
}
export const activeCondos = async () => (await getCondos()).filter((c) => c.status === 'active');
export function invalidateCondos() { state.condos = null; }

export const typeInfo = (code) => (state.meta?.utility_types || []).find((t) => t.code === code) || { code, name: code, unit: '', icon: 'gauge' };
export const activeTypes = () => (state.meta?.utility_types || []).filter((t) => t.active);

/** Condomínio selecionado por último (lembrado entre as telas). */
export const currentCondo = {
  get: () => pref.get('condo', ''),
  set: (id) => pref.set('condo', id ? Number(id) : ''),
};
