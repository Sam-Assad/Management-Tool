import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Routes, Route, Link, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import ServersDashboard from './pages/ServersDashboard';
import ServerDetail from './pages/ServerDetail';
import GroupRedirect from './pages/GroupRedirect';
import SoftwareCatalogPage from './pages/SoftwareCatalogPage';
import ConditionsPage from './pages/ConditionsPage';
import JobDetailPage from './pages/JobDetailPage';
import UsersPage from './pages/UsersPage';
import TopBar from './components/TopBar';
import BeatAlertModal from './components/BeatAlertModal';
import { IconServer, IconCatalog, IconConditions, IconChevronLeft, IconChevronRight, IconPlus, IconUsers } from './components/Icons';
import { useAuth, useCan } from './auth/AuthContext';
import { NO_PERMISSION, roleName } from './auth/permissions';
import {
  AuthenticatorRequiredPage,
  AuthenticatorSetup,
  ChangePasswordForm,
  ForcedChangePasswordPage,
  LoginPage,
  ResetPasswordPage,
  SetupPage,
} from './auth/AuthScreens';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem('hc-sidebar-collapsed') === '1';
  } catch {
    return false;
  }
}

const navClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;

// Who decides what's on screen: sign-in states first, the app itself only once someone is signed in.
export default function App() {
  const { state, user, refresh } = useAuth();
  const location = useLocation();
  if (state === 'loading') return <div className="auth-page auth-loading">Loading…</div>;
  // a one-time reset link (from npm run reset-password) works whether or not someone is signed in on this browser
  if (location.pathname === '/reset-password') return <ResetPasswordPage />;
  if (state === 'error')
    return (
      <div className="auth-page auth-loading">
        <p>Healthcheck's server isn't answering.</p>
        <button onClick={() => refresh()}>Try again</button>
      </div>
    );
  if (state === 'setup') return <SetupPage />;
  if (state === 'signedOut' || !user) return <LoginPage />;
  if (user.must_change_password) return <ForcedChangePasswordPage />;
  if (user.needs_authenticator) return <AuthenticatorRequiredPage />;
  return <Shell />;
}

// Admins: move the authenticator app to a new phone (asks for the password).
function AuthenticatorDialog({ onClose }: { onClose: () => void }) {
  const { signedIn } = useAuth();
  const [done, setDone] = useState(false);
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal auth-dialog" role="dialog" aria-labelledby="ta-title">
        <div className="modal-header">
          <h2 id="ta-title">Authenticator app</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {done ? (
          <>
            <div className="auth-info">Done. From now on, use the codes from the new phone. The old phone's codes no longer work.</div>
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <p className="auth-sub">
              Your authenticator app is set up. It's how you get back in if you forget your password. To use a different
              phone, scan the code below with it. The old phone stops working once you confirm.
            </p>
            <AuthenticatorSetup
              onDone={(u) => {
                signedIn(u);
                setDone(true);
              }}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { signedIn } = useAuth();
  const [done, setDone] = useState(false);
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal auth-dialog" role="dialog" aria-labelledby="cp-title">
        <div className="modal-header">
          <h2 id="cp-title">Change password</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {done ? (
          <>
            <div className="auth-info">Your password was changed. You've been signed out on every other browser.</div>
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <ChangePasswordForm
            onDone={(u) => {
              signedIn(u);
              setDone(true);
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function Shell() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [changingPassword, setChangingPassword] = useState(false);
  const [authenticatorOpen, setAuthenticatorOpen] = useState(false);
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const can = useCan();

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('hc-sidebar-collapsed', next ? '1' : '0');
    } catch {
      // per-viewer convenience only - fine if storage is unavailable
    }
  }

  const initials = (user?.display_name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell">
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sb-head">
          <Link to="/" className="brand" title="Healthcheck">
            <img src="/logo.png" alt="Vodafone" className="brand-logo" />
            {!collapsed && (
              <span className="brand-text">
                Healthcheck
                <span className="brand-tag">Loyalty Platform Ops</span>
              </span>
            )}
          </Link>
          <button
            className="sb-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        </div>

        <nav>
          <div className="sb-section">Operate</div>
          <NavLink to="/" end className={navClass} title="Servers">
            <IconServer />
            <span className="nav-label">Servers</span>
          </NavLink>

          <div className="sb-section">Configure</div>
          <NavLink to="/software" className={navClass} title="Software Catalog">
            <IconCatalog />
            <span className="nav-label">{collapsed ? 'Catalog' : 'Software Catalog'}</span>
          </NavLink>
          <NavLink to="/conditions" className={navClass} title="Conditions">
            <IconConditions />
            <span className="nav-label">Conditions</span>
          </NavLink>
          {user?.is_admin && (
            <NavLink to="/users" className={navClass} title="Users">
              <IconUsers />
              <span className="nav-label">Users</span>
            </NavLink>
          )}
        </nav>

        <div className="sb-foot">
          {!collapsed && <p>Manage another server from anywhere in the tool.</p>}
          <button
            className="sb-add"
            onClick={() => navigate('/?add=1')}
            title={can('manage_servers') ? 'Add server' : NO_PERMISSION}
            aria-label="Add server"
            disabled={!can('manage_servers')}
          >
            <IconPlus size={15} />
            {!collapsed && <span>Add server</span>}
          </button>
          <div className="sb-user" title={`${user?.display_name} (${user?.username})`}>
            <span className="sb-avatar" aria-hidden="true">
              {initials}
            </span>
            {!collapsed && (
              <span className="sb-user-text">
                <b>{user?.display_name}</b>
                <span>{roleName(user?.permissions ?? [])}</span>
              </span>
            )}
          </div>
          <div className={`sb-user-actions${collapsed ? ' sb-user-actions-col' : ''}`}>
            <button onClick={() => setChangingPassword(true)} title="Change password">
              {collapsed ? 'Pwd' : 'Change password'}
            </button>
            <button onClick={() => signOut()} title="Sign out">
              {collapsed ? 'Out' : 'Sign out'}
            </button>
          </div>
          {user?.is_admin && (
            <button className="sb-small-link" onClick={() => setAuthenticatorOpen(true)} title="Your way back in if you forget your password">
              {collapsed ? 'App' : 'Authenticator app'}
            </button>
          )}
        </div>
      </aside>
      <main className="page">
        <TopBar />
        <Routes>
          <Route path="/" element={<ServersDashboard />} />
          <Route path="/servers/:serverId" element={<ServerDetail />} />
          <Route path="/groups/:groupId" element={<GroupRedirect />} />
          <Route path="/software" element={<SoftwareCatalogPage />} />
          <Route path="/conditions" element={<ConditionsPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/users" element={user?.is_admin ? <UsersPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BeatAlertModal />
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
      {authenticatorOpen && <AuthenticatorDialog onClose={() => setAuthenticatorOpen(false)} />}
    </div>
  );
}
