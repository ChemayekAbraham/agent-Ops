import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PersonNameFields from '@/components/shared/PersonNameFields';

const empty = { firstName: '', otherNames: '', lastName: '' };

describe('PersonNameFields', () => {
  it('renders three labelled inputs', () => {
    render(<PersonNameFields idPrefix="t1" value={empty} onChange={() => {}} />);
    expect(screen.getByLabelText(/First name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Other names/i)).toBeInTheDocument();
  });

  it('marks first and last as required, other names as optional', () => {
    render(<PersonNameFields idPrefix="t2" value={empty} onChange={() => {}} />);
    expect(screen.getByText('First name *')).toBeInTheDocument();
    expect(screen.getByText('Last name *')).toBeInTheDocument();
    expect(screen.getByText('Other names (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText(/First name/i)).toBeRequired();
    expect(screen.getByLabelText(/Last name/i)).toBeRequired();
    expect(screen.getByLabelText(/Other names/i)).not.toBeRequired();
  });

  it('fires onChange with the correct part', () => {
    const onChange = vi.fn();
    render(<PersonNameFields idPrefix="t3" value={empty} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: 'Alice' } });
    expect(onChange).toHaveBeenLastCalledWith({ firstName: 'Alice', otherNames: '', lastName: '' });
    fireEvent.change(screen.getByLabelText(/Other names/i), { target: { value: 'Grace' } });
    expect(onChange).toHaveBeenLastCalledWith({ firstName: '', otherNames: 'Grace', lastName: '' });
    fireEvent.change(screen.getByLabelText(/Last name/i), { target: { value: 'Nakato' } });
    expect(onChange).toHaveBeenLastCalledWith({ firstName: '', otherNames: '', lastName: 'Nakato' });
  });

  it('propagates disabled to all inputs', () => {
    render(<PersonNameFields idPrefix="t4" value={empty} onChange={() => {}} disabled />);
    expect(screen.getByLabelText(/First name/i)).toBeDisabled();
    expect(screen.getByLabelText(/Last name/i)).toBeDisabled();
    expect(screen.getByLabelText(/Other names/i)).toBeDisabled();
  });

  it('renders inline errors', () => {
    render(
      <PersonNameFields
        idPrefix="t5"
        value={empty}
        onChange={() => {}}
        errors={{ firstName: 'First name is required', lastName: 'Last name is required' }}
      />,
    );
    expect(screen.getByText('First name is required')).toBeInTheDocument();
    expect(screen.getByText('Last name is required')).toBeInTheDocument();
    expect(screen.getByLabelText(/First name/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('uses idPrefix for unique ids', () => {
    render(<PersonNameFields idPrefix="signup" value={empty} onChange={() => {}} />);
    expect(screen.getByLabelText(/First name/i)).toHaveAttribute('id', 'signup-first-name');
    expect(screen.getByLabelText(/Other names/i)).toHaveAttribute('id', 'signup-other-names');
  });

  it('matches the mobile-width render snapshot', () => {
    const { container } = render(
      <div style={{ width: 375 }}>
        <PersonNameFields idPrefix="m" value={{ firstName: 'Alice', otherNames: '', lastName: 'Nakato' }} onChange={() => {}} />
      </div>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});