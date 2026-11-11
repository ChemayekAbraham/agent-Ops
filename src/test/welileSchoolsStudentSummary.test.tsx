import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The test environment has no Supabase URL; nothing here talks to the database.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import StudentProfileSummary from '@/components/welile-schools/StudentProfileSummary';
import { parseStudentQr, showsStream, studentCode, studentQrValue, type SchoolProfileRow } from '@/lib/welileSchools';

const ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const row: SchoolProfileRow = {
  id: ID, school_id: 's1', role: 'pupil', full_name: 'Amina Nakato', gender: 'Female', class_grade: 'S2', stream: 'East',
  boarding_status: 'Day', guardian_name: 'Sarah Nakato', guardian_phone: '0772123456', id_number: 'ADM-0042',
} as SchoolProfileRow;

describe('student QR helpers', () => {
  it('builds a short code from the profile id', () => {
    expect(studentCode(ID)).toBe('WS-3F2A-9C1E');
  });
  it('puts only the profile id in the QR code, and reads it back', () => {
    const value = studentQrValue(ID);
    expect(value).toBe(`welile-schools:student:${ID}`);
    expect(value).not.toMatch(/Amina|0772/);
    expect(parseStudentQr(value)).toBe(ID);
  });
  it('rejects codes that are not Welile Schools student codes', () => {
    expect(parseStudentQr('https://example.com')).toBeNull();
    expect(parseStudentQr('welile-schools:student:not-an-id')).toBeNull();
  });
});

describe('StudentProfileSummary', () => {
  it('shows the details, the code and a QR code after a successful registration', () => {
    const { container } = render(
      <StudentProfileSummary row={row} saved photoUrl={null} school={{ name: 'Migeera SS' }} onNext={() => {}} />,
    );
    expect(screen.getByText('Registration successful')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Amina Nakato' })).toBeInTheDocument();
    expect(screen.getAllByText('WS-3F2A-9C1E').length).toBeGreaterThan(0);
    expect(screen.getByText('Sarah Nakato')).toBeInTheDocument();
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Register the next student/ })).toBeInTheDocument();
  });

  it('says the record is on the phone when it could not upload yet', () => {
    render(<StudentProfileSummary row={row} saved={false} photoUrl={null} school={{ name: 'Migeera SS' }} onNext={() => {}} />);
    expect(screen.getByText('Saved on this phone')).toBeInTheDocument();
  });

  it('shows the captured photo when there is one', () => {
    render(<StudentProfileSummary row={row} saved photoUrl="blob:photo" school={{ name: 'Migeera SS' }} onNext={() => {}} />);
    expect(screen.getByRole('img', { name: 'Photo of Amina Nakato' })).toHaveAttribute('src', 'blob:photo');
  });
});


describe('showsStream', () => {
  it('shows stream / dormitory up to secondary school', () => {
    expect(showsStream('S2')).toBe(true);
    expect(showsStream('P5')).toBe(true);
    expect(showsStream('Baby class')).toBe(true);
  });
  it('hides it for vocational and university classes', () => {
    expect(showsStream('Diploma year 1')).toBe(false);
    expect(showsStream('Year 3')).toBe(false);
    expect(showsStream('Postgraduate')).toBe(false);
  });
  it('goes by the school level until a class is chosen', () => {
    expect(showsStream('', 'University/Tertiary')).toBe(false);
    expect(showsStream(null, 'Secondary/High School')).toBe(true);
    expect(showsStream('S2', 'University/Tertiary')).toBe(true);
  });
  it('keeps it for a free-text class saved before the dropdown', () => {
    expect(showsStream('senior 2', 'Secondary/High School')).toBe(true);
  });
});
