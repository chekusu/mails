import { describe, expect, test } from 'bun:test'
import { extractCode } from '../../worker/src/extract-code'

describe('extractCode', () => {
  test('extracts Chinese verification code', () => {
    expect(extractCode('您的验证码：123456')).toBe('123456')
    expect(extractCode('您的验证码: 789012')).toBe('789012')
    expect(extractCode('确认码：ABCD12')).toBe('ABCD12')
  })

  test('extracts English verification code', () => {
    expect(extractCode('Your verification code is 654321')).toBe('654321')
    expect(extractCode('Your verification code: 111222')).toBe('111222')
    expect(extractCode('confirmation code: 998877')).toBe('998877')
    expect(extractCode('security code: 4455')).toBe('4455')
    expect(extractCode('Your OTP: 7890')).toBe('7890')
    expect(extractCode('OTP Code:114669')).toBe('114669')
    expect(extractCode('passcode: 5678')).toBe('5678')
    expect(extractCode('pin code: 9012')).toBe('9012')
  })

  test('extracts Japanese verification code', () => {
    expect(extractCode('認証コード：345678')).toBe('345678')
  })

  test('extracts Korean verification code', () => {
    expect(extractCode('인증 코드: 456789')).toBe('456789')
  })

  test('extracts "code is/:" pattern', () => {
    expect(extractCode('Your code is 112233')).toBe('112233')
    expect(extractCode('code: ABCDEF')).toBe('ABCDEF')
  })

  test('extracts standalone digit codes', () => {
    expect(extractCode('Please enter 5678 to verify')).toBe('5678')
    expect(extractCode(' 12345678 ')).toBe('12345678')
  })

  test('returns null when no code found', () => {
    expect(extractCode('Hello, this is a regular email')).toBeNull()
    expect(extractCode('')).toBeNull()
    expect(extractCode('OTP Code')).toBeNull()
    expect(extractCode('Short 12')).toBeNull()
  })

  test('handles mixed content', () => {
    expect(extractCode('Subject: Login 验证码：998877 please check')).toBe('998877')
  })
})
