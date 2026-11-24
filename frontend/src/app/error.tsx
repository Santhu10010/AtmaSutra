"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold">AtmaSutra could not render this page</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">Your local data was not changed. Try loading the page again.</p>
      <button type="button" onClick={reset} className="mt-6 min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700">
        Try again
      </button>
    </main>
  );
}
