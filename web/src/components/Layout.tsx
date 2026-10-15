import { createContext, useContext, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Building2,
  ClipboardList,
  FileSpreadsheet,
  Gauge,
  Headphones,
  History,
  ListChecks,
  LogOut,
  PhoneForwarded,
  Server,
  Settings2,
  Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import type { Company } from '../api/types';

/** Super admins can pin the whole console to one company; everyone else is already scoped. */
const CompanyScopeContext = createContext<{ companyId: string; setCompanyId: (id: string) => void }>({
  companyId: '',
  setCompanyId: () => {},
});

export function useCompanyScope(): { companyId: string; setCompanyId: (id: string) => void } {
  return useContext(CompanyScopeContext);
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: <Gauge size={16} />, perm: 'dashboard.view' }],
  },
  {
    group: 'Call queues',
    items: [
      { to: '/queues/transfer', label: 'Transfers', icon: <PhoneForwarded size={16} />, perm: 'queues.view' },
      { to: '/queues/unclosed', label: 'Unclosed', icon: <ArrowLeftRight size={16} />, perm: 'queues.view' },
      { to: '/queues/closed', label: 'Closed', icon: <BadgeCheck size={16} />, perm: 'queues.view' },
    ],
  },
  {
    group: 'Quality',
    items: [
      { to: '/qa/forms', label: 'QA forms', icon: <ClipboardList size={16} />, perm: 'qa.forms.manage' },
      { to: '/qa/evaluations', label: 'Evaluations', icon: <ListChecks size={16} />, perm: 'qa.view' },
      { to: '/reports/agents', label: 'Agent report', icon: <BarChart3 size={16} />, perm: 'reports.view' },
    ],
  },
  {
    group: 'Administration',
    items: [
      { to: '/admin/companies', label: 'Companies', icon: <Building2 size={16} />, perm: 'admin.companies' },
      { to: '/admin/dialers', label: 'Dialer servers', icon: <Server size={16} />, perm: 'admin.dialers' },
      { to: '/admin/agents', label: 'Agents', icon: <Headphones size={16} />, perm: 'admin.agents' },
      { to: '/admin/dispositions', label: 'Dispositions', icon: <Settings2 size={16} />, perm: 'admin.dispositions' },
      { to: '/admin/users', label: 'Users & roles', icon: <Users size={16} />, perm: 'admin.users' },
      { to: '/admin/sync', label: 'Sync monitor', icon: <Activity size={16} />, perm: 'admin.sync' },
      { to: '/admin/audit', label: 'Audit log', icon: <History size={16} />, perm: 'admin.audit' },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, hasPerm, isSuperAdmin, logout } = useAuth();
  const [companyId, setCompanyId] = useState('');

  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
    enabled: isSuperAdmin,
  });

  return (
    <CompanyScopeContext.Provider value={{ companyId, setCompanyId }}>
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-ink/10 bg-surface">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand font-display text-sm font-bold text-white">
              Q
            </div>
            <div>
              <div className="font-display text-sm font-bold leading-tight">VICIdial QA</div>
              <div className="text-2xs text-ink-3">Call quality console</div>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-4">
            {NAV.map((group) => {
              const visible = group.items.filter((i) => {
                if (i.perm && !hasPerm(i.perm)) return false;
                // a reviewer limited to certain methods only sees those queues
                const queue = i.to.match(/^\/queues\/(\w+)$/)?.[1];
                if (queue && user?.allowedQueues && !hasPerm('qa.forms.manage')) {
                  return user.allowedQueues.includes(queue as 'transfer' | 'unclosed' | 'closed');
                }
                return true;
              });
              if (visible.length === 0) return null;
              return (
                <div key={group.group} className="mt-4">
                  <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-widest text-ink-3">
                    {group.group}
                  </div>
                  {visible.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                          isActive
                            ? 'bg-brand-soft font-semibold text-brand'
                            : 'text-ink-2 hover:bg-bg hover:text-ink'
                        }`
                      }
                    >
                      {item.icon}
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="border-t border-ink/10 p-3">
            <div className="mb-2 px-1">
              <div className="truncate text-sm font-medium">{user?.name}</div>
              <div className="truncate text-2xs text-ink-3">
                {user?.roleName.replace(/_/g, ' ')} · {user?.email}
              </div>
            </div>
            <button onClick={() => void logout()} className="btn-secondary w-full justify-center">
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </aside>

        <div className="ml-56 flex-1">
          {isSuperAdmin && (
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink/10 bg-surface px-6 py-2">
              <FileSpreadsheet size={14} className="text-ink-3" />
              <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2">
                Company scope
              </span>
              <select
                className="input w-64"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                aria-label="Company scope"
              >
                <option value="">All companies</option>
                {companiesData?.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
        </div>
      </div>
    </CompanyScopeContext.Provider>
  );
}
