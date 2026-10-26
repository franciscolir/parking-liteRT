import { vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// MOCKS GLOBALES PARA BROWSER APIs
// ============================================================

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock navigator.mediaDevices
Object.defineProperty(navigator, 'mediaDevices', {
  writable: true,
  value: {
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{
        stop: vi.fn(),
        applyConstraints: vi.fn(),
        getSettings: () => ({ facingMode: 'environment' }),
      }],
    }),
  },
});

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = value.toString(); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    _getStore: () => store,
    _setStore: (s) => { store = s; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock indexedDB
const mockIDB = {
  open: vi.fn().mockImplementation(() => {
    const req = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: {
        createObjectStore: vi.fn(),
        transaction: vi.fn().mockReturnValue({
          objectStore: vi.fn().mockReturnValue({
            put: vi.fn().mockReturnValue({ onsuccess: null }),
            get: vi.fn().mockReturnValue({ onsuccess: null }),
            getAll: vi.fn().mockReturnValue({ onsuccess: null }),
            delete: vi.fn().mockReturnValue({ onsuccess: null }),
            clear: vi.fn().mockReturnValue({ onsuccess: null }),
          }),
        }),
        objectStoreNames: { contains: vi.fn().mockReturnValue(false) },
      },
    };
    setTimeout(() => req.onsuccess?.({ target: req.result }), 0);
    return req;
  }),
};
Object.defineProperty(window, 'indexedDB', { value: mockIDB });

// Mock performance.now
let perfTime = 0;
vi.spyOn(performance, 'now').mockImplementation(() => {
  perfTime += 16; // ~60fps
  return perfTime;
});

// Mock navigator.vibrate
Object.defineProperty(navigator, 'vibrate', {
  writable: true,
  value: vi.fn(),
});

// Mock window.open
Object.defineProperty(window, 'open', {
  writable: true,
  value: vi.fn(),
});

// Mock crypto.randomUUID
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  },
});

// ============================================================
// MOCK SUPABASE CLIENT
// ============================================================

const createMockQuery = () => ({
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(),
  gt: vi.fn().mockReturnThis(),
  lt: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  lte: vi.fn().mockReturnThis(),
  like: vi.fn().mockReturnThis(),
  ilike: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  range: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  then: vi.fn().mockResolvedValue({ data: [], error: null }),
});

const mockSupabase = {
  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { user: null, session: null }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { user: null, session: null }, error: null }),
    signInWithOAuth: vi.fn().mockResolvedValue({ data: { provider: 'google' }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    onAuthStateChange: vi.fn().mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    }),
  },
  from: vi.fn((table) => createMockQuery()),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ data: { path: 'test' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'http://test.com/img.jpg' } }),
      download: vi.fn().mockResolvedValue({ data: new Blob(), error: null }),
    })),
  },
  channel: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
    unsubscribe: vi.fn(),
  })),
};

vi.mock('./supabase-client.js', () => ({
  supabase: mockSupabase,
  signUp: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getCurrentUser: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  lookupPlate: vi.fn(),
  getPlates: vi.fn(),
  reportPlate: vi.fn(),
  saveScan: vi.fn(),
  getScanHistory: vi.fn(),
  getScanStats: vi.fn(),
  getContacts: vi.fn(),
  addContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  subscribeToPlates: vi.fn(),
  subscribeToScanHistory: vi.fn(),
  subscribeToContacts: vi.fn(),
  isAuthenticated: vi.fn(),
  getUserId: vi.fn(),
  PlateType: { REGISTERED: 'registered', STOLEN: 'stolen', WANTED: 'wanted', SUSPICIOUS: 'suspicious' },
  ScanStatus: { REGISTERED: 'registered', STOLEN: 'stolen', UNKNOWN: 'unknown', ERROR: 'error' },
  ContactType: { POLICE: 'police', FIRE: 'fire', EMERGENCY: 'emergency', OFFICE: 'office', CUSTOM: 'custom' },
}));

// Exportar mocks para uso en tests
export const testMocks = {
  supabase: mockSupabase,
  localStorage: localStorageMock,
  resetLocalStorage: () => localStorageMock._setStore({}),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock._setStore({});
  perfTime = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});