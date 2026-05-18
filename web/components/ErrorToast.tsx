import { useEffect } from "react";
import { usePanes } from "../state/panes.ts";

export function ErrorToast() {
  const error = usePanes((s) => s.error);
  const setError = usePanes((s) => s.setError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, setError]);

  if (!error) return null;
  return (
    <div className="error-toast">
      <span>{error}</span>
      <button onClick={() => setError(null)} aria-label="dismiss">×</button>
    </div>
  );
}
