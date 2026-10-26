import { iconFor } from './icons.js';

// Widened: a new variant and a new optional prop. Every element written for
// 2.3.0 still type-checks.
type ButtonProps = {
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
  icon?: string;
};

function className(variant: ButtonProps['variant'], hasIcon: boolean): string {
  return hasIcon ? `btn btn-${variant} btn-icon` : `btn btn-${variant}`;
}

export function Button(props: ButtonProps) {
  return (
    <button className={className(props.variant, props.icon !== undefined)}>
      {iconFor({ name: props.icon ?? props.variant, size: 16 })}
      {props.label}
    </button>
  );
}
