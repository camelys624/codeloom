import type { ComponentPropsWithoutRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const EMPTY_VALUE = '__codeloom_empty__';

function Select({
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props} />;
}

function SelectGroup({
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group {...props} />;
}

function SelectValue({
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn('select-trigger', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="select-icon">
        <ChevronDown size={16} strokeWidth={1.8} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Content
      className={cn('select-content', className)}
      position={position}
      sideOffset={4}
      {...props}
    >
      <SelectPrimitive.Viewport className="select-viewport">
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  );
}

function SelectLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('select-label', className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn('select-item', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="select-item-indicator">
        <Check size={15} strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn('select-separator', className)}
      {...props}
    />
  );
}

function AppSelect({
  value,
  onValueChange,
  options,
  placeholder,
  ariaLabel,
  disabled = false,
  required = false,
  stopPropagation = false,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  stopPropagation?: boolean;
  className?: string;
}) {
  const normalizedOptions = options.map((option) => ({
    ...option,
    value: option.value || EMPTY_VALUE,
  }));
  const content = (
    <SelectContent>
      {normalizedOptions.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectContent>
  );
  return (
    <Select
      value={value || undefined}
      onValueChange={(nextValue) =>
        onValueChange(nextValue === EMPTY_VALUE ? '' : nextValue)
      }
      disabled={disabled}
      required={required}
    >
      <SelectTrigger
        className={className}
        aria-label={ariaLabel}
        onClick={(event) => {
          if (stopPropagation) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => {
          if (stopPropagation) event.stopPropagation();
        }}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPrimitive.Portal>{content}</SelectPrimitive.Portal>
    </Select>
  );
}

export {
  AppSelect,
  EMPTY_VALUE,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};

export type SelectOption = { value: string; label: string };
export type SelectContentProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Content
>;
export type SelectTriggerProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
>;
export type SelectItemProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Item
>;
export type SelectRootProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Root
>;
export type SelectValueProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Value
>;
export type SelectGroupProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Group
>;
export type SelectLabelProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Label
>;
export type SelectSeparatorProps = ComponentPropsWithoutRef<
  typeof SelectPrimitive.Separator
>;
