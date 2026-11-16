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
    render(<ScannedStudentCard student={student} now={{ direction: 'in', recorded_at: '2026-11-16T06:00:00Z' }} used={NONE} onRecord={onRecord} onScanNext={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Record exit/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Recording an entry instead/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record entry/ }));
    await waitFor(() => expect(onRecord).toHaveBeenCalledWith('in'));
  });

  it('after an entry today, offers only the exit', () => {
    render(<ScannedStudentCard student={student} now={{ direction: 'in', recorded_at: '2026-11-16T06:00:00Z' }} used={{ in: true, out: false }} onRecord={async () => {}} onScanNext={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Record exit/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Recording an entry instead/ })).toBeNull();
    expect(screen.getByText('Entry already recorded today.')).toBeInTheDocument();
  });

  it('after an entry and an exit today, records nothing more', () => {
    render(<ScannedStudentCard student={student} now={{ direction: 'out', recorded_at: '2026-11-16T12:00:00Z' }} used={{ in: true, out: true }} onRecord={async () => {}} onScanNext={() => {}} onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: /Record (entry|exit)/ })).toBeNull();
    expect(screen.getByText(/Done for today/)).toBeInTheDocument();
  });

  it('shows the reason when the record is refused', async () => {
    const onRecord = vi.fn(async () => { throw new Error('Amina Nakato already has an entry recorded today.'); });
    render(<ScannedStudentCard student={student} now={null} used={NONE} onRecord={onRecord} onScanNext={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Record entry/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has an entry recorded today');
  });
});

describe('studentMovesToday', () => {
  const log = (direction: 'in' | 'out', recorded_at: string, profile_id = 'p1'): SchoolGateLogRow =>
    ({ id: `${direction}-${recorded_at}`, school_id: 's1', profile_id, direction, person_name: 'A', role_type: 'pupil', recorded_at } as SchoolGateLogRow);
  const NOW = new Date('2026-11-16T09:00:00Z'); // 12:00 in Kampala

  it('counts only this student, today in Kampala time', () => {
    const logs = [
      log('in', '2026-11-16T04:30:00Z'),            // 07:30 today
      log('out', '2026-11-15T20:30:00Z'),           // 23:30 yesterday
      log('out', '2026-11-16T05:00:00Z', 'p2'),     // someone else
    ];
    expect(studentMovesToday(logs, 'p1', NOW)).toEqual({ in: true, out: false });
  });

  it('treats 22:00 UTC as the next Kampala day', () => {
    expect(studentMovesToday([log('out', '2026-11-15T22:00:00Z')], 'p1', NOW)).toEqual({ in: false, out: true });
  });
});
