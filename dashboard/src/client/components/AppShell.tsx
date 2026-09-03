import { ArrowClockwise, BookOpen, Books, CalendarBlank, ChartBar, CheckSquare, Folder, Gear, GridFour, List, Note } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

function Navigation() {
  const items = [
    { to: "/", label: "学习总览", icon: GridFour, end: true },
    { to: "/courses", label: "课程", icon: Books },
    { to: "/tasks", label: "任务", icon: CheckSquare },
    { to: "/notes", label: "笔记", icon: Note },
    { to: "/review", label: "复习", icon: ArrowClockwise },
    { to: "/resources", label: "资源", icon: Folder },
    { to: "/calendar", label: "日历", icon: CalendarBlank },
    { to: "/stats", label: "统计", icon: ChartBar },
    { to: "/settings", label: "设置", icon: Gear },
  ];
  return (
    <nav aria-label="主导航">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink to={to} end={end} key={to}>
          <Icon size={22} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

const PAGE_TITLES: Array<[string, string]> = [
  ["/courses/", "课程详情"], ["/courses", "课程"], ["/tasks", "任务"], ["/notes", "笔记"], ["/review", "复习"],
  ["/resources", "资源"], ["/calendar", "日历"], ["/stats", "统计"], ["/settings", "设置"], ["/", "学习总览"],
];

export function AppShell({ children, connection }: { children: ReactNode; connection: "connecting" | "live" | "warning" }) {
  const location = useLocation();
  const title = PAGE_TITLES.find(([path]) => path === "/" ? location.pathname === "/" : location.pathname.startsWith(path))?.[1] ?? "学习总览";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="学习进度仪表盘"><BookOpen size={34} weight="light" /></div>
        <Navigation />
        <div className="sidebar-status">
          <span className={`connection-dot connection-dot--${connection}`} aria-hidden="true" />
          {connection === "live" ? "本地数据已连接" : connection === "warning" ? "正在重新连接" : "正在连接数据"}
        </div>
      </aside>

      <div className="mobile-header">
        <div className="mobile-brand"><BookOpen size={25} /><span>{title}</span></div>
        <details className="mobile-menu">
          <summary aria-label="打开主导航"><List size={24} /></summary>
          <Navigation />
        </details>
      </div>

      <main className="main-area">
        <header className="page-header">
          <h1>{title}</h1>
          <div className="motto">
            <span>学而不思则罔，思而不学则殆。</span>
            <b aria-label="勤学">勤<br />学</b>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
