import type { AppMenuItem, SectionId } from '../shared/types/navigation';

export const appMenuItems: AppMenuItem[] = [
  {
    id: 'bid-generation',
    label: '标书生成',
    description: '技术方案编制',
    children: [
      {
        id: 'technical-plan',
        label: '生成技术方案',
        description: '根据招标文件重头编写一份标书',
        icon: 'document',
      },
      {
        id: 'existing-plan-expansion',
        label: '已有方案扩写',
        description: '解决人写技术方案太薄的问题，上传写好的方案，进行优化和扩充，遵从原方案真实可落地，又能扩写出厚厚的标书',
        icon: 'expand',
      },
    ],
  },
  {
    id: 'template-settings',
    label: '模版设置',
    description: '标书导出模板与排版配置',
    children: [
      {
        id: 'my-templates',
        label: '我的模板',
        description: '管理已保存的标书导出模板',
        icon: 'document',
      },
      {
        id: 'new-template',
        label: '新建模板',
        description: '配置 Word 文档排版与编号格式',
        icon: 'export',
      },
    ],
  },
];

export function getAppMenuItems(): AppMenuItem[] {
  return appMenuItems;
}

export function getSectionOrder(): SectionId[] {
  return getAppMenuItems().flatMap((item) => [item.id, ...(item.children?.map((child) => child.id) ?? [])]);
}

export function getAppMenuItemById(id: SectionId): AppMenuItem | undefined {
  return getAppMenuItems().find((item) => item.id === id);
}

export function getParentMenuItemBySection(section: SectionId): AppMenuItem | undefined {
  return getAppMenuItems().find((item) => item.id === section || item.children?.some((child) => child.id === section));
}