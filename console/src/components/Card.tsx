import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export default function Card({ title, sub, right, footer, className, children }: CardProps) {
  const hasHead = title !== undefined || sub !== undefined || right !== undefined;
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {hasHead ? (
        <div className="ch">
          {title !== undefined ? <h3>{title}</h3> : null}
          {sub !== undefined ? <span className="sub">{sub}</span> : null}
          {right !== undefined ? <div className="right">{right}</div> : null}
        </div>
      ) : null}
      {children}
      {footer !== undefined ? <div className="foot">{footer}</div> : null}
    </section>
  );
}
