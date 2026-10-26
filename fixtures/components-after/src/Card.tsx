export interface Theme {
  background: string;
  foreground: string;
}

// Narrowed: `theme` became required, so <Card title="x" /> no longer compiles.
interface CardProps {
  title: string;
  theme: Theme;
}

export const Card = ({ title, theme }: CardProps) => (
  <section style={{ background: theme.background, color: theme.foreground }}>
    <h2>{title}</h2>
  </section>
);
