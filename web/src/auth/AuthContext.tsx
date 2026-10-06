import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, SIGNED_OUT_EVENT } from '../api/client';
import type { Permission } from './permissions';

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  permissions: Permission[];
  must_change_password: boolean;
}

// can('stop_all') -> may the signed-in person do it? (The server checks again; this only greys out buttons.)
export function useCan(): (p: Permission) => boolean {
  const { user } = useAuth();
  return (p) => Boolean(user?.permissions?.includes(p));
}

interface AuthStatus {
  setup_needed: boolean;
  user: User | null;
  min_password_length: number;
}

interface AuthValue {
  // loading: asking the server; setup: nobody exists yet; signedOut; signedIn
  state: 'loading' | 'setup' | 'signedOut' | 'signedIn' | 'error';
  user: User | null;
  minLength: number;
  // why we're on the sign-in page, when it wasn't the user's own choice
  notice: string | null;
  signedIn: (user: User) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<AuthStatus>('/auth/status'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // the server ended the session (expired, password reset by an admin, account disabled)
  useEffect(() => {
    const onSignedOut = () => {
      setStatus((s) => {
        if (s?.user && !s.user.must_change_password) setNotice('Your session has ended. Please sign in again.');
        return s;
      });
      queryClient.clear();
      refresh();
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [queryClient, refresh]);

  const value: AuthValue = {
    state: failed ? 'error' : !status ? 'loading' : status.setup_needed ? 'setup' : status.user ? 'signedIn' : 'signedOut',
    user: status?.user ?? null,
    minLength: status?.min_password_length ?? 12,
    notice,
    signedIn: (user) => {
      setNotice(null);
      queryClient.clear();
      setStatus((s) => ({ setup_needed: false, min_password_length: s?.min_password_length ?? 12, user }));
    },
    signOut: async () => {
      try {
        await api.post('/auth/logout');
      } finally {
        queryClient.clear();
        setNotice(null);
        setStatus((s) => (s ? { ...s, user: null } : s));
      }
    },
    refresh,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
