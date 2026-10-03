import { useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useNavigate } from 'react-router-dom';
import ServersDashboard from './pages/ServersDashboard';
import ServerDetail from './pages/ServerDetail';
import GroupRedirect from './pages/GroupRedirect';
import SoftwareCatalogPage from './pages/SoftwareCatalogPage';
import ConditionsPage from './pages/ConditionsPage';
import JobDetailPage from './pages/JobDetailPage';
import TopBar from './components/TopBar';
import BeatAlertModal from './components/BeatAlertModal';
import { IconServer, IconCatalog, IconConditions, IconChevronLeft, IconChevronRight, IconPlus } from './components/Icons';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem('hc-sidebar-collapsed') === '1';
  } catch {
    return false;
  }
}

const navClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;

export default function App() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const navigate = useNavigate();

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('hc-sidebar-collapsed', next ? '1' : '0');
    } catch {
      // per-viewer convenience only - fine if storage is unavailable
    }
  }

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
        </nav>

        <div className="sb-foot">
          {!collapsed && <p>Manage another server from anywhere in the tool.</p>}
          <button className="sb-add" onClick={() => navigate('/?add=1')} title="Add server" aria-label="Add server">
            <IconPlus size={15} />
            {!collapsed && <span>Add server</span>}
          </button>
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BeatAlertModal />
    </div>
  );
}
