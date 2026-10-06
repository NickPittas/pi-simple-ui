import { useEffect } from 'react';

/** The Workers nav item opens the observed-subagents list inside the conversation page (messages live there). */
export function WorkersRedirect({ onRedirect }: { readonly onRedirect: () => void }) {
  useEffect(() => { onRedirect(); }, []);
  return <div className="empty-state" role="status"><h2>Opening observed subagents</h2></div>;
}
