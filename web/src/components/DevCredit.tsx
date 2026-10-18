import { Github } from 'lucide-react';

export const DEVELOPER = { name: 'Abdul Manan', github: 'https://github.com/abdulmanan69' };

/** Developer credit shown at the bottom of every page and on the login screen. */
export function DevCredit({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-2xs text-ink-3 ${className}`}>
      <span>Developed by</span>
      <a
        href={DEVELOPER.github}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-brand hover:underline"
        title="Abdul Manan on GitHub"
      >
        <Github size={12} /> {DEVELOPER.name}
      </a>
    </p>
  );
}
