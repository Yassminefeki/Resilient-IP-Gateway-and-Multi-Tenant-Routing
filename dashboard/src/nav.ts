import {
  Activity,
  Boxes,
  Flame,
  Gauge,
  Network,
  Route,
  ServerCog,
  Settings2,
  Timer,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  end?: boolean;
  section?: 'Operate' | 'Insight';
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: Gauge, end: true },
  { to: '/drill', label: 'Live Drill', icon: Flame, section: 'Operate' },
  { to: '/sandboxes', label: 'Sandboxes', icon: Boxes, section: 'Operate' },
  { to: '/gateways', label: 'Gateways', icon: ServerCog, section: 'Operate' },
  { to: '/routes', label: 'Traffic & Routes', icon: Route, section: 'Operate' },
  { to: '/configuration', label: 'Configuration', icon: Settings2, section: 'Operate' },
  { to: '/ipam', label: 'IP Address Management', shortLabel: 'IPAM', icon: Network, section: 'Insight' },
  { to: '/observability', label: 'Observability', icon: Activity, section: 'Insight' },
  { to: '/benchmarks', label: 'Benchmarks', icon: Timer, section: 'Insight' },
];
