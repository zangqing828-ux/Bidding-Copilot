import { useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);

  useEffect(() => {
    trackAppOpen();
    void window.yibiao?.config.load()
      .then((config) => {
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取配置失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
  }, [activeSection]);

  const requestSectionChange = async (section: SectionId) => {
    if (section === activeSection) {
      return;
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      setActiveSection(section);
    }
  };

  return (
    <AppShell
      activeSection={activeSection}
      onSectionChange={(section) => { void requestSectionChange(section); }}
    >
      <AppRouter
        activeSection={activeSection}
        onSectionChange={(section) => { void requestSectionChange(section); }}
        registerLeaveGuard={(guard) => {
          leaveGuardRef.current = guard;
        }}
      />
    </AppShell>
  );
}

export default App;