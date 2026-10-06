import { APP_PREFERENCE_AREAS, type AppPreferenceArea } from '../../shared/app-preferences.ts'

const titles: Record<AppPreferenceArea, string> = { conversation: 'Conversation', workers: 'Workers', sessions: 'Sessions', models: 'Models', extensions: 'Extensions', settings: 'Settings' }
export function Navigation({ active, onSelect, hideAreas = [] }: { active: AppPreferenceArea; onSelect: (area: AppPreferenceArea) => void; hideAreas?: readonly string[] }) {
  return <nav className="primary-nav" aria-label="Product areas">{APP_PREFERENCE_AREAS.map((area, i) => hideAreas.includes(area) ? null : <button key={area} className={`nav-item${active === area ? ' nav-item-current' : ''}`} aria-label={titles[area]} title={titles[area]} aria-current={active === area ? 'page' : undefined} onClick={() => onSelect(area)}><span className="nav-icon" aria-hidden="true">{['\uf086','\uf0c0','\uf1da','\uf2db','\uf12e','\uf013'][i]}</span><span>{titles[area]}</span></button>)}</nav>
}
