import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The test environment has no Supabase URL; the card only needs a photo link.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/welileSchoolsPhoto', () => ({ studentPhotoUrl: vi.fn(async () => 'https://example.test/photo.jpg') }));

import ScannedStudentCard from '@/components/welile-schools/ScannedStudentCard';
import { studentMovesToday, type SchoolGateLogRow, type SchoolProfileRow } from '@/lib/welileSchools';

const NONE = { in: false, out: false };

const student: SchoolProfileRow = {
  id: '3f2a9c1e-0000-4000-8000-000000000001', school_id: 's1', registered_by: 'a1', role: 'pupil',
  full_name: 'Amina Nakato', class_grade: 'P4', stream: 'Blue', boarding_status: 'Day', gender: 'Female', age: 10,
  guardian_name: 'Sarah Nakato', guardian_phone: '0700000001', photo_path: 's1/3f2a.jpg',
};

describe('Scanned student card', () => {
  it('shows the photo and details, and records an entry for someone not inside', async () => {
    const onRecord = vi.fn(async () => {});
    render(<ScannedStudentCard student={student} now={null} used={NONE} onRecord={onRecord} onScanNext={() => {}} onDone={() => {}} />);
    expect(screen.getByText('Amina Nakato')).toBeInTheDocument();
    expect(screen.getByText('P4 · Blue')).toBeInTheDocument();
    expect(screen.getByText('Sarah Nakato')).toBeInTheDocument();
    expect(await screen.findByAltText('Photo of Amina Nakato')).toHaveAttribute('src', 'https://example.test/photo.jpg');
    fireEvent.click(screen.getByRole('button', { name: /Record entry/ }));
    await waitFor(() => expect(onRecord).toHaveBeenCalledWith('in'));
    expect(await screen.findByText(/recorded entering/)).toBeInTheDocument();
  });

  it('offers an exit for a student who is inside, and can switch to an entry', async () => {
    const onRecord = vi.fn(async () => {});
    render(<ScannedStudentCard student={student} now={{ direction: 'in', recorded_at: '2026-11-16T06:00:00Z' }} onRecord={onRecord} onScanNext={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Record exit/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Recording an entry instead/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record entry/ }));
    await waitFor(() => expect(onRecord).toHaveBeenCalledWith('in'));
  });
});
