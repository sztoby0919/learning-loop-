import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { CalendarEvent } from "../../shared/course.js";

function shiftMonth(month: string, delta: number) { const [year, value] = month.split("-").map(Number); const date = new Date(Date.UTC(year, value - 1 + delta, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

export function CalendarPage({ month, events, onMonthChange }: { month: string; events: CalendarEvent[]; onMonthChange: (month: string) => void }) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells = Array.from({ length: Math.ceil((firstDay + days) / 7) * 7 }, (_, index) => index - firstDay + 1);
  return <div className="workspace-page"><div className="calendar-toolbar"><button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="上个月"><CaretLeft /></button><h2>{year} 年 {monthNumber} 月</h2><button onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label="下个月"><CaretRight /></button></div><div className="calendar-weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>周{day}</span>)}</div><div className="calendar-grid">{cells.map((day, index) => { const date = `${month}-${String(day).padStart(2, "0")}`; const dayEvents = day > 0 && day <= days ? events.filter((event) => event.date === date) : []; return <div className={`calendar-day${day < 1 || day > days ? " calendar-day--outside" : ""}`} key={index}>{day > 0 && day <= days && <time dateTime={date}>{day}</time>}{dayEvents.map((event) => <article key={event.id} style={{ borderLeftColor: event.accent }}><strong>{event.title}</strong><span>{event.courseTitle}</span></article>)}</div>; })}</div>{events.length === 0 && <p className="empty-copy">本月没有日程、复习日期或学习记录。</p>}</div>;
}
