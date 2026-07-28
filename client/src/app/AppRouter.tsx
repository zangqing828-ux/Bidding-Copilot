import { useEffect, useState } from 'react';
import type { SectionId } from '../shared/types/navigation';
import { getAppMenuItemById } from './menuConfig';
import ExportFormatPage from '../features/export-format/pages/ExportFormatPage';
import MyTemplatesPage from '../features/export-format/pages/MyTemplatesPage';
import SettingsPage from '../features/settings/pages/SettingsPage';
import TechnicalPlanHome from '../features/technical-plan/pages/TechnicalPlanHome';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';

interface AppRouterProps {
  activeSection: SectionId;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
}

function AppRouter({ activeSection, onSectionChange, registerLeaveGuard }: AppRouterProps) {
  const activeMenuItem = getAppMenuItemById(activeSection);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (activeSection !== 'my-templates') {
      setEditingTemplateId(null);
    }
  }, [activeSection]);

  if (activeMenuItem?.children?.length) {
    return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
  }

  switch (activeSection) {
    case 'technical-plan':
      return <TechnicalPlanHome workflowKind="technical-plan" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'existing-plan-expansion':
      return <TechnicalPlanHome workflowKind="existing-plan-expansion" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'my-templates':
      return editingTemplateId
        ? <ExportFormatPage mode="edit" templateId={editingTemplateId} onBack={() => setEditingTemplateId(null)} />
        : <MyTemplatesPage onCreateTemplate={() => onSectionChange('new-template')} onEditTemplate={setEditingTemplateId} />;
    case 'new-template':
      return <ExportFormatPage mode="create" />;
    case 'export-format':
      return <ExportFormatPage mode="create" />;
    case 'settings':
      return <SettingsPage />;
    default:
      return null;
  }
}

export default AppRouter;