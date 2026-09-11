import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Input, Modal, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'

interface ProfileBackupPasswordModalProps {
  mode: 'export' | 'import' | null
  busy: boolean
  onSubmit: (password: string) => Promise<void>
  onClose: () => void
}

export function ProfileBackupPasswordModal({ mode, busy, onSubmit, onClose }: ProfileBackupPasswordModalProps) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')

  useEffect(() => {
    setPassword('')
    setConfirmation('')
  }, [mode])

  const valid = password.length >= 10 && password.length <= 200 && (mode === 'import' || password === confirmation)

  return (
    <Modal
      open={mode !== null}
      title={mode === 'export' ? '导出加密环境数据备份' : '导入加密环境数据备份'}
      okText={mode === 'export' ? '选择保存位置' : '选择备份文件'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !valid }}
      closable={!busy}
      maskClosable={!busy}
      onOk={() => void onSubmit(password)}
      onCancel={onClose}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          icon={<SafetyCertificateOutlined />}
          title={mode === 'export' ? '备份内容将使用 AES-256-GCM 加密' : '先验证密码和文件完整性，再创建新环境'}
          description={mode === 'export'
            ? '浏览器数据和环境配置都会加密写入单个备份文件；备份文件中不保存密码。'
            : '密码错误、文件损坏或内容被修改时不会导入，已有环境不会被覆盖。'}
        />
        <div>
          <Typography.Text strong><LockOutlined /> 备份密码</Typography.Text>
          <Input.Password
            value={password}
            autoComplete={mode === 'export' ? 'new-password' : 'current-password'}
            placeholder="至少 10 个字符"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {mode === 'export' && (
          <div>
            <Typography.Text strong>再次输入密码</Typography.Text>
            <Input.Password
              value={confirmation}
              autoComplete="new-password"
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {confirmation && password !== confirmation && <Typography.Text type="danger">两次输入的密码不一致</Typography.Text>}
          </div>
        )}
        <Typography.Text type="secondary">密码只用于本次加密或解密，应用不会保存。密码遗失后无法恢复备份。</Typography.Text>
      </Space>
    </Modal>
  )
}
