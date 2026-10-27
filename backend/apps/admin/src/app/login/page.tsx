import { LoginForm } from './LoginForm';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  return (
    <main className="login">
      <p className="brand">
        JIMMY WAX<small>Operator console</small>
      </p>
      <h1>Sign in</h1>
      {expired ? (
        <p role="alert" className="notice warn">
          Your session expired. Please sign in again.
        </p>
      ) : null}
      <LoginForm />
    </main>
  );
}
