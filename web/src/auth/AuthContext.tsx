import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { AuthUser } from '../api/types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  hasPerm: (perm: string) => boolean;
  isSuperAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<{ user: AuthUser }>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return { user: null };
        throw err;
      }
    },
    retry: false,
  });

  const user = data?.user ?? null;

  const value: AuthContextValue = {
    user,
    loading: isLoading,
    hasPerm: (perm) => !!user && (user.permissions.includes('*') || user.permissions.includes(perm)),
    isSuperAdmin: !!user && user.companyId === null && user.permissions.includes('*'),
    login: async (email, password) => {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    logout: async () => {
      await api('/auth/logout', { method: 'POST' });
      queryClient.clear();
      window.location.href = '/login';
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
