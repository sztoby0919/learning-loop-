import { useContext, useEffect } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router-dom";

// Legacy MemoryRouter fixtures do not implement navigation blockers. The app uses a data router.
export function ImportNavigationGuard({ hasUnsavedChanges }: { hasUnsavedChanges: () => boolean }) {
  const context = useContext(UNSAFE_DataRouterContext);
  return context ? <DataNavigationGuard hasUnsavedChanges={hasUnsavedChanges} /> : null;
}

function DataNavigationGuard({ hasUnsavedChanges }: { hasUnsavedChanges: () => boolean }) {
  const blocker = useBlocker(hasUnsavedChanges);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("草稿有未保存的编辑。离开将丢弃这些编辑，确定离开吗？")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  return null;
}
