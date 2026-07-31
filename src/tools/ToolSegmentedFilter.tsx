import type { ReactElement } from 'react';

export type ToolSegmentedOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
};

type ToolSegmentedFilterProps<T extends string> = {
  label?: string;
  labelId?: string;
  options: readonly ToolSegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  /** Classes on the outer wrapper (labeled layout only). */
  className?: string;
  /** Classes on the inner `tool-segmented` element. */
  segmentedClassName?: string;
  /** Render only the segmented button group (no label row wrapper). */
  unlabeled?: boolean;
};

/** Label + `tool-segmented` button group used across tool filter rows. */
export function ToolSegmentedFilter<T extends string>({
  label,
  labelId,
  options,
  value,
  disabled = false,
  onChange,
  className,
  segmentedClassName,
  unlabeled = false,
}: ToolSegmentedFilterProps<T>): ReactElement {
  const resolvedLabelId =
    labelId ?? (label ? `tool-segmented-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

  const segmented = (
    <div
      className={['tool-segmented', segmentedClassName].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={resolvedLabelId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'active' : ''}
          aria-pressed={value === option.value}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  if (unlabeled) {
    return segmented;
  }

  return (
    <div className={['tool-field tool-field-label-row', className].filter(Boolean).join(' ')}>
      {label ? (
        <span className="tool-field-label" id={resolvedLabelId}>
          {label}
        </span>
      ) : null}
      {segmented}
    </div>
  );
}
