import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmbeddingSection from './index';
import { getEmbeddingOrigins, saveEmbeddingOrigins } from './embeddingApi';

vi.mock('./embeddingApi', () => ({
  getEmbeddingOrigins: vi.fn(),
  saveEmbeddingOrigins: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function renderSection(origins: string[] = []) {
  vi.mocked(getEmbeddingOrigins).mockResolvedValue(origins);
  render(<EmbeddingSection />);
  await waitFor(() => expect(getEmbeddingOrigins).toHaveBeenCalled());
  return screen.getByRole('textbox', { name: 'Site to add' });
}

it('says that no other site may embed until one is listed', async () => {
  await renderSection();

  expect(
    screen.getByRole('heading', { name: 'Sites that may embed NEXT HMI' }),
  ).toBeInTheDocument();
  expect(screen.getByText(/By default no other site can show these screens/)).toBeInTheDocument();
  expect(await screen.findByText('No sites listed.')).toBeInTheDocument();
});

it('adds a typed site after the listed ones and shows what the backend stored', async () => {
  const input = await renderSection(['https://portal.example.com']);
  vi.mocked(saveEmbeddingOrigins).mockResolvedValue([
    'https://portal.example.com',
    'https://intranet.example.com',
  ]);

  await userEvent.type(input, '  https://Intranet.example.com/ ');
  await userEvent.click(screen.getByRole('button', { name: 'Add site' }));

  expect(saveEmbeddingOrigins).toHaveBeenCalledWith([
    'https://portal.example.com',
    'https://Intranet.example.com/',
  ]);
  expect(await screen.findByText('https://intranet.example.com')).toBeInTheDocument();
  expect(input).toHaveValue('');
});

it('adds on Enter too', async () => {
  const input = await renderSection();
  vi.mocked(saveEmbeddingOrigins).mockResolvedValue(['https://portal.example.com']);

  await userEvent.type(input, 'https://portal.example.com{Enter}');

  expect(saveEmbeddingOrigins).toHaveBeenCalledWith(['https://portal.example.com']);
});

it('shows why a site was refused and keeps the typed text to correct', async () => {
  const input = await renderSection();
  const refusal = '"portal" is not a site address.';
  vi.mocked(saveEmbeddingOrigins).mockRejectedValue(new Error(refusal));

  await userEvent.type(input, 'portal{Enter}');

  expect(await screen.findByText(refusal)).toBeInTheDocument();
  expect(input).toHaveValue('portal');
  expect(screen.getByText('No sites listed.')).toBeInTheDocument();
});

it('removes one site with a single save', async () => {
  await renderSection(['https://a.example.com', 'https://b.example.com']);
  vi.mocked(saveEmbeddingOrigins).mockResolvedValue(['https://b.example.com']);

  await userEvent.click(
    await screen.findByRole('button', { name: 'Remove https://a.example.com' }),
  );

  expect(saveEmbeddingOrigins).toHaveBeenCalledTimes(1);
  expect(saveEmbeddingOrigins).toHaveBeenCalledWith(['https://b.example.com']);
  await waitFor(() => expect(screen.queryByText('https://a.example.com')).not.toBeInTheDocument());
});

it('saves nothing for a blank entry', async () => {
  const input = await renderSection();

  await userEvent.type(input, '   {Enter}');

  expect(saveEmbeddingOrigins).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Add site' })).toBeDisabled();
});
