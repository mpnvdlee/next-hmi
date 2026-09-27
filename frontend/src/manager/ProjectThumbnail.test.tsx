import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ProjectThumbnail from './ProjectThumbnail';

describe('ProjectThumbnail', () => {
  it('renders a placeholder with the project initial when there is no thumbnail', () => {
    render(<ProjectThumbnail id="p1" name="Plant A" updatedAt={null} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('P')).toBeInTheDocument();
  });

  it('renders the image with a cache-busting timestamp', () => {
    render(<ProjectThumbnail id="p1" name="Plant A" updatedAt="2026-09-12T10:00:00+00:00" />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('/api/projects/p1/thumbnail');
    expect(img.getAttribute('src')).toContain('v=');
  });

  it('falls back to the placeholder when the thumbnail request fails', () => {
    render(<ProjectThumbnail id="p1" name="Plant A" updatedAt="2026-09-12T10:00:00+00:00" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('P')).toBeInTheDocument();
  });

  it('retries with a plain img once a fresh save provides a new timestamp', () => {
    const { rerender } = render(
      <ProjectThumbnail id="p1" name="Plant A" updatedAt="2026-09-12T10:00:00+00:00" />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();

    rerender(<ProjectThumbnail id="p1" name="Plant A" updatedAt="2026-09-12T11:00:00+00:00" />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});
