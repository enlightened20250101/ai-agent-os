import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-slate-600">The page you are looking for does not exist.</p>
      <Link className="rounded-md bg-slate-900 px-4 py-2 text-white hover:bg-slate-800" href="/">
        Go home
      </Link>
    </main>
  );
}
