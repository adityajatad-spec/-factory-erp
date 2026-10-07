import { useId, useState, type ReactNode } from 'react';
import { Input } from './field';

/**
 * Keyboard-first search-and-pick control (↑ ↓ to move, Enter to choose, Esc to close).
 * The parent owns searching: it receives the typed query and supplies matching options.
 */
export function Combobox<T>({
  options,
  value,
  onSelect,
  query,
  onQueryChange,
  getKey,
  getLabel,
  renderOption,
  placeholder,
  loading = false,
  autoFocus = false,
  inputId,
}: {
  options: readonly T[];
  value: T | null;
  onSelect: (option: T) => void;
  query: string;
  onQueryChange: (q: string) => void;
  getKey: (o: T) => string;
  getLabel: (o: T) => string;
  renderOption?: (o: T) => ReactNode;
  placeholder?: string;
  loading?: boolean;
  autoFocus?: boolean;
  inputId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const choose = (o: T) => {
    onSelect(o);
    onQueryChange('');
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={open ? query : value ? getLabel(value) : ''}
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.currentTarget.select();
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            const o = options[active];
            if (o) {
              e.preventDefault();
              choose(o);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full min-w-64 overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          {loading && options.length === 0 && (
            <li className="px-3 py-2 text-slate-500">Searching…</li>
          )}
          {!loading && options.length === 0 && (
            <li className="px-3 py-2 text-slate-500">No matches</li>
          )}
          {options.map((o, i) => (
            <li
              key={getKey(o)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? 'bg-accent-50 text-slate-900' : 'text-slate-700'}`}
            >
              {renderOption ? renderOption(o) : getLabel(o)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
