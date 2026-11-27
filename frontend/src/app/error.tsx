"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">AtmaSutra could not render this page</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">Your local data was not changed. Try loading the page again.</p>
      <button type="button" onClick={reset} className="primary-button mt-6 rounded-lg px-4 py-2 font-semibold">
        Try again
      </button>
    </main>
  );
}
