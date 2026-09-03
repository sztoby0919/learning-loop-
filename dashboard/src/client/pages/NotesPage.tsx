import { Link } from "react-router-dom";

import type { CourseSummary, NoteDocument } from "../../shared/course.js";
import { MarkdownContent } from "../components/MarkdownContent.js";

interface NotesPageProps {
  courses: CourseSummary[];
  notes: NoteDocument[];
  selectedId?: string;
}

export function NotesPage({ courses, notes, selectedId }: NotesPageProps) {
  const visibleNotes = selectedId ? notes.filter((note) => note.courseId === selectedId) : notes;
  const courseMeta = new Map(courses.map((course) => [course.id, course]));
  const groups = new Map<string, { title: string; notes: NoteDocument[] }>();
  const ungrouped: NoteDocument[] = [];

  for (const note of notes) {
    if (!note.groupId || !note.groupTitle) {
      ungrouped.push(note);
      continue;
    }
    const group = groups.get(note.groupId) ?? { title: note.groupTitle, notes: [] };
    group.notes.push(note);
    groups.set(note.groupId, group);
  }

  const noteLink = (note: NoteDocument) => (
    <Link className={selectedId === note.courseId ? "active" : undefined} key={note.courseId} to={`/notes/${note.courseId}`}>
      {note.title ?? courseMeta.get(note.courseId)?.shortTitle ?? note.courseId}
      <small>{note.headings.length} 个主题</small>
    </Link>
  );

  return (
    <div className="notes-layout">
      <aside className="notes-index">
        <h2>课程笔记</h2>
        {ungrouped.map(noteLink)}
        {[...groups.entries()].map(([id, group]) => (
          <section className="notes-group" key={id}>
            <h3>{group.title}</h3>
            <div>{group.notes.map(noteLink)}</div>
          </section>
        ))}
      </aside>
      <div className="notes-documents">
        {visibleNotes.length === 0 ? <p className="empty-copy">暂无可显示的笔记内容。</p> : visibleNotes.map((note) => (
          <article className="workspace-panel markdown-body" key={note.courseId} style={{ borderTopColor: note.accent ?? courseMeta.get(note.courseId)?.accent }}>
            <MarkdownContent>{note.markdown}</MarkdownContent>
          </article>
        ))}
      </div>
    </div>
  );
}
