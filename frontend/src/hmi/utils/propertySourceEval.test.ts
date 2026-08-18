import {
  evaluatePropertyValue,
  type EvaluationContext,
  type ResolvedValue,
} from './propertySourceEval';

describe('propertySourceEval', () => {
  // Mock context with example implementations
  const mockContext: EvaluationContext = {
    resolveVariable: (datasource, path) => {
      if (datasource === 'PLC1' && path === 'Temperature') {
        return 42;
      }
      if (datasource === 'PLC1' && path === 'Status') {
        return true;
      }
      return null;
    },
    resolveTranslation: (key) => {
      if (key === 'label.temperature') {
        return 'Temperature (°C)';
      }
      return `[${key}]`; // Fallback
    },
    getUrlParam: (name) => {
      if (name === 'debug') {
        return 'true';
      }
      return undefined;
    },
    isPageActive: (pageId) => {
      return pageId === 'home';
    },
  };

  describe('plain values (no wrapper)', () => {
    it('passes through string', () => {
      expect(evaluatePropertyValue('hello')).toBe('hello');
    });

    it('passes through number', () => {
      expect(evaluatePropertyValue(42)).toBe(42);
    });

    it('passes through boolean', () => {
      expect(evaluatePropertyValue(true)).toBe(true);
    });

    it('passes through null', () => {
      expect(evaluatePropertyValue(null)).toBe(null);
    });

    it('passes through undefined', () => {
      expect(evaluatePropertyValue(undefined)).toBe(undefined);
    });

    it('returns undefined for plain object', () => {
      const obj = { key: 'value' };
      expect(evaluatePropertyValue(obj)).toBe(undefined);
    });
  });

  describe('unknown / malformed wrappers', () => {
    it('returns null for an unknown $-prefixed wrapper key', () => {
      expect(evaluatePropertyValue({ $unknown: 'anything' })).toBe(null);
    });

    it('returns null for a future wrapper key not in the dispatcher', () => {
      expect(evaluatePropertyValue({ $futureType: { value: 42 } })).toBe(null);
    });

    it('returns undefined for a plain object with no $-prefixed key', () => {
      expect(evaluatePropertyValue({ key: 'value' })).toBe(undefined);
    });
  });

  describe('$static wrapper', () => {
    it('returns static value', () => {
      expect(evaluatePropertyValue({ $static: 'hello' })).toBe('hello');
    });

    it('returns static number', () => {
      expect(evaluatePropertyValue({ $static: 123 })).toBe(123);
    });
  });

  describe('$var wrapper', () => {
    it('resolves existing variable', () => {
      const result = evaluatePropertyValue(
        {
          $var: {
            path: 'PLC1:Temperature',
          },
        },
        mockContext,
      );
      expect(result).toBe(42);
    });

    it('returns null for missing variable', () => {
      const result = evaluatePropertyValue(
        {
          $var: {
            path: 'Unknown:Unknown',
          },
        },
        mockContext,
      );
      expect(result).toBe(null);
    });

    it('returns null without resolver', () => {
      const result = evaluatePropertyValue({
        $var: {
          path: 'PLC1:Temperature',
        },
      });
      expect(result).toBe(null);
    });
  });

  describe('$loc wrapper', () => {
    it('resolves translation key', () => {
      const result = evaluatePropertyValue({ $loc: 'label.temperature' }, mockContext);
      expect(result).toBe('Temperature (°C)');
    });

    it('returns key as fallback without resolver', () => {
      const result = evaluatePropertyValue({ $loc: 'unknown.key' });
      expect(result).toBe('unknown.key');
    });
  });

  describe('$urlParam wrapper', () => {
    it('reads URL parameter', () => {
      const result = evaluatePropertyValue(
        {
          $urlParam: {
            name: 'debug',
            default: 'false',
          },
        },
        mockContext,
      );
      expect(result).toBe('true');
    });

    it('returns default when param missing', () => {
      const result = evaluatePropertyValue(
        {
          $urlParam: {
            name: 'missing',
            default: 'fallback',
          },
        },
        mockContext,
      );
      expect(result).toBe('fallback');
    });

    it('returns null without default', () => {
      const result = evaluatePropertyValue(
        {
          $urlParam: {
            name: 'missing',
          },
        },
        mockContext,
      );
      expect(result).toBe(null);
    });
  });

  describe('$pageIsActive wrapper', () => {
    it('returns true for active page', () => {
      const result = evaluatePropertyValue(
        {
          $pageIsActive: {
            page: 'home',
          },
        },
        mockContext,
      );
      expect(result).toBe(true);
    });

    it('returns false for inactive page', () => {
      const result = evaluatePropertyValue(
        {
          $pageIsActive: {
            page: 'about',
          },
        },
        mockContext,
      );
      expect(result).toBe(false);
    });

    it('returns false without checker', () => {
      const result = evaluatePropertyValue({
        $pageIsActive: {
          page: 'home',
        },
      });
      expect(result).toBe(false);
    });

    it('falls back to hostPageId when page is omitted', () => {
      const result = evaluatePropertyValue(
        { $pageIsActive: {} },
        { ...mockContext, hostPageId: 'home' },
      );
      expect(result).toBe(true);
    });

    it('falls back to hostPageId when page is empty string', () => {
      const result = evaluatePropertyValue(
        { $pageIsActive: { page: '' } },
        { ...mockContext, hostPageId: 'home' },
      );
      expect(result).toBe(true);
    });

    it('returns false when page omitted and no hostPageId', () => {
      const result = evaluatePropertyValue({ $pageIsActive: {} }, mockContext);
      expect(result).toBe(false);
    });

    it('explicit page overrides hostPageId', () => {
      const result = evaluatePropertyValue(
        { $pageIsActive: { page: 'about' } },
        { ...mockContext, hostPageId: 'home' },
      );
      expect(result).toBe(false);
    });
  });

  describe('$if wrapper', () => {
    it('evaluates true branch when condition is true', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: true,
            true: 'yes',
            false: 'no',
          },
        },
        mockContext,
      );
      expect(result).toBe('yes');
    });

    it('evaluates false branch when condition is false', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: false,
            true: 'yes',
            false: 'no',
          },
        },
        mockContext,
      );
      expect(result).toBe('no');
    });

    it('supports nested $var in condition', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: {
              $var: {
                path: 'PLC1:Status',
              },
            },
            true: 'active',
            false: 'inactive',
          },
        },
        mockContext,
      );
      expect(result).toBe('active');
    });

    it('supports $pageIsActive as condition (true branch on active page)', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: { $pageIsActive: { page: 'home' } },
            true: 'on home',
            false: 'elsewhere',
          },
        },
        mockContext,
      );
      expect(result).toBe('on home');
    });

    it('supports $pageIsActive as condition (false branch on inactive page)', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: { $pageIsActive: { page: 'about' } },
            true: 'on about',
            false: 'elsewhere',
          },
        },
        mockContext,
      );
      expect(result).toBe('elsewhere');
    });

    it('treats null condition as false', () => {
      const result = evaluatePropertyValue(
        { $if: { condition: null, true: 'yes', false: 'no' } },
        mockContext,
      );
      expect(result).toBe('no');
    });
  });

  describe('$compare wrapper', () => {
    it('evaluates greater-than', () => {
      const result = evaluatePropertyValue(
        {
          $compare: {
            left: 10,
            operator: '>',
            right: 5,
          },
        },
        mockContext,
      );
      expect(result).toBe(true);
    });

    it('evaluates less-than', () => {
      const result = evaluatePropertyValue(
        {
          $compare: {
            left: 3,
            operator: '<',
            right: 5,
          },
        },
        mockContext,
      );
      expect(result).toBe(true);
    });

    it('evaluates greater-or-equal', () => {
      const result = evaluatePropertyValue(
        {
          $compare: {
            left: 5,
            operator: '>=',
            right: 5,
          },
        },
        mockContext,
      );
      expect(result).toBe(true);
    });

    it('evaluates less-or-equal', () => {
      const result = evaluatePropertyValue(
        {
          $compare: {
            left: 3,
            operator: '<=',
            right: 5,
          },
        },
        mockContext,
      );
      expect(result).toBe(true);
    });

    it('=== coerces number against numeric string', () => {
      expect(
        evaluatePropertyValue({ $compare: { left: 5, operator: '===', right: '5' } }, mockContext),
      ).toBe(true);
      expect(
        evaluatePropertyValue({ $compare: { left: '5', operator: '===', right: 5 } }, mockContext),
      ).toBe(true);
    });

    it('=== keeps strict semantics for same-typed values', () => {
      // boolean vs number: not coerced — stays false
      expect(
        evaluatePropertyValue(
          { $compare: { left: 0, operator: '===', right: false } },
          mockContext,
        ),
      ).toBe(false);
      // string-vs-string: leading zeros distinguish
      expect(
        evaluatePropertyValue(
          { $compare: { left: '5', operator: '===', right: '05' } },
          mockContext,
        ),
      ).toBe(false);
    });

    it('!== inverts loose equality', () => {
      expect(
        evaluatePropertyValue({ $compare: { left: 5, operator: '!==', right: '5' } }, mockContext),
      ).toBe(false);
      expect(
        evaluatePropertyValue({ $compare: { left: 5, operator: '!==', right: '6' } }, mockContext),
      ).toBe(true);
    });
  });

  describe('$random wrapper', () => {
    it('generates random number within range', () => {
      const result = evaluatePropertyValue(
        {
          $random: {
            min: 0,
            max: 100,
            integer: true,
          },
        },
        mockContext,
      );
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('generates float when integer=false', () => {
      const result = evaluatePropertyValue(
        {
          $random: {
            min: 0,
            max: 1,
            integer: false,
          },
        },
        mockContext,
      );
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  describe('$switch wrapper', () => {
    it('matches case and returns then value', () => {
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: 'red',
            cases: [
              { when: 'red', then: '#FF0000' },
              { when: 'green', then: '#00FF00' },
              { when: 'blue', then: '#0000FF' },
            ],
            default: '#000000',
          },
        },
        mockContext,
      );
      expect(result).toBe('#FF0000');
    });

    it('returns default when no match', () => {
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: 'yellow',
            cases: [
              { when: 'red', then: '#FF0000' },
              { when: 'green', then: '#00FF00' },
            ],
            default: '#000000',
          },
        },
        mockContext,
      );
      expect(result).toBe('#000000');
    });

    it('supports nested $var as switch value', () => {
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: {
              $var: {
                path: 'PLC1:Status',
              },
            },
            cases: [
              { when: true, then: 'ON' },
              { when: false, then: 'OFF' },
            ],
            default: 'UNKNOWN',
          },
        },
        mockContext,
      );
      expect(result).toBe('ON');
    });

    it('supports $pageIsActive as switch value', () => {
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: { $pageIsActive: { page: 'home' } },
            cases: [
              { when: true, then: 'on home' },
              { when: false, then: 'somewhere else' },
            ],
            default: 'unknown',
          },
        },
        mockContext,
      );
      expect(result).toBe('on home');
    });

    it('matches across number/string with numeric coercion', () => {
      // 5 (number) vs "5" (string) — should match under loose equality
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: 5,
            cases: [{ when: '5', then: 'matched' }],
            default: 'fallback',
          },
        },
        mockContext,
      );
      expect(result).toBe('matched');
    });

    it('does not coerce non-numeric strings', () => {
      const result = evaluatePropertyValue(
        {
          $switch: {
            value: 5,
            cases: [{ when: 'phone', then: 'matched' }],
            default: 'fallback',
          },
        },
        mockContext,
      );
      expect(result).toBe('fallback');
    });
  });

  describe('complex nested expressions', () => {
    it('evaluates $if with nested $var and $compare condition', () => {
      const result = evaluatePropertyValue(
        {
          $if: {
            condition: {
              $compare: {
                left: {
                  $var: {
                    path: 'PLC1:Temperature',
                  },
                },
                operator: '>',
                right: 30,
              },
            },
            true: 'ALERT: Temperature too high',
            false: 'Normal',
          },
        },
        mockContext,
      );
      expect(result).toBe('ALERT: Temperature too high');
    });

    it('returns null when nested depth exceeds recursion limit', () => {
      let deep: unknown = { $var: { path: 'PLC1:Temperature' } };
      for (let i = 0; i < 100; i += 1) {
        deep = { $if: { condition: true, true: deep, false: null } };
      }

      expect(evaluatePropertyValue(deep, mockContext)).toBeNull();
    });
  });

  describe('$user wrapper', () => {
    const userContext: EvaluationContext = {
      ...mockContext,
      resolveUser: (field) => {
        if (field === 'username') return 'operator1';
        if (field === 'groups') return 'operator, guest';
        return null;
      },
    };

    it('resolves username field', () => {
      expect(evaluatePropertyValue({ $user: { field: 'username' } }, userContext)).toBe(
        'operator1',
      );
    });

    it('resolves groups field', () => {
      expect(evaluatePropertyValue({ $user: { field: 'groups' } }, userContext)).toBe(
        'operator, guest',
      );
    });

    it('returns null when resolveUser is not provided', () => {
      expect(evaluatePropertyValue({ $user: { field: 'username' } }, mockContext)).toBeNull();
    });

    it('returns null for unknown field', () => {
      expect(evaluatePropertyValue({ $user: { field: 'unknown' } }, userContext)).toBeNull();
    });

    // `userList` is an array source, so its home is the record-list path; on a
    // scalar field it joins rather than resolving to nothing, which is what it
    // used to do — the editor offered the option and it silently never resolved.
    it('resolves userList on a scalar field by joining the names', () => {
      const ctx: EvaluationContext = {
        ...userContext,
        resolveUserList: () => ['admin', 'operator1'],
      };
      expect(evaluatePropertyValue({ $user: { field: 'userList' } }, ctx)).toBe('admin, operator1');
    });

    it('resolves userList without a resolveUser resolver', () => {
      const ctx: EvaluationContext = { resolveUserList: () => ['admin'] };
      expect(evaluatePropertyValue({ $user: { field: 'userList' } }, ctx)).toBe('admin');
    });

    it('returns null for userList when there are no users', () => {
      const ctx: EvaluationContext = { ...userContext, resolveUserList: () => [] };
      expect(evaluatePropertyValue({ $user: { field: 'userList' } }, ctx)).toBeNull();
    });
  });

  describe('$device wrapper', () => {
    const deviceContext: EvaluationContext = {
      ...mockContext,
      resolveDevice: (field) => {
        if (field === 'hostname') return 'panel-line-3';
        if (field === 'ipAddress') return '10.0.4.12';
        if (field === 'macAddress') return 'aa:bb:cc:dd:ee:ff';
        return null;
      },
    };

    it('resolves hostname field', () => {
      expect(evaluatePropertyValue({ $device: { field: 'hostname' } }, deviceContext)).toBe(
        'panel-line-3',
      );
    });

    it('resolves ipAddress field', () => {
      expect(evaluatePropertyValue({ $device: { field: 'ipAddress' } }, deviceContext)).toBe(
        '10.0.4.12',
      );
    });

    it('resolves macAddress field', () => {
      expect(evaluatePropertyValue({ $device: { field: 'macAddress' } }, deviceContext)).toBe(
        'aa:bb:cc:dd:ee:ff',
      );
    });

    it('returns null when resolveDevice is not provided', () => {
      expect(evaluatePropertyValue({ $device: { field: 'hostname' } }, mockContext)).toBeNull();
    });

    it('returns null for unknown field', () => {
      expect(
        evaluatePropertyValue({ $device: { field: 'serialNumber' } }, deviceContext),
      ).toBeNull();
    });
  });

  describe('$widgetProp wrapper', () => {
    const store: Record<string, Record<string, unknown>> = {
      'source-table': {
        selectedRow: { id: 'r1', name: 'Recipe One', tags: ['a', 'b'] },
        selectedRowId: 'r1',
      },
    };
    const widgetContext: EvaluationContext = {
      ...mockContext,
      resolveComponentProp: (componentId, property) =>
        (store[componentId]?.[property] ?? null) as ResolvedValue,
    };

    it('resolves a scalar exported property', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'source-table', property: 'selectedRowId' } },
          widgetContext,
        ),
      ).toBe('r1');
    });

    it('drills into a struct field via path', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'source-table', property: 'selectedRow', path: 'name' } },
          widgetContext,
        ),
      ).toBe('Recipe One');
    });

    it('indexes into an array segment', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'source-table', property: 'selectedRow', path: 'tags/1' } },
          widgetContext,
        ),
      ).toBe('b');
    });

    it('returns null for a missing field', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'source-table', property: 'selectedRow', path: 'nope' } },
          widgetContext,
        ),
      ).toBeNull();
    });

    it('reads the whole value when path is empty', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'source-table', property: 'selectedRowId', path: '' } },
          widgetContext,
        ),
      ).toBe('r1');
    });

    it('returns null when the source component has no value', () => {
      expect(
        evaluatePropertyValue(
          { $widgetProp: { componentId: 'missing', property: 'selectedRow', path: 'name' } },
          widgetContext,
        ),
      ).toBeNull();
    });
  });

  describe('$time wrapper', () => {
    const timeContext: EvaluationContext = {
      ...mockContext,
      resolveTime: (format, timezone) => `${format ?? 'default'}|${timezone ?? 'local'}`,
    };

    it('resolves time via context callback', () => {
      expect(
        evaluatePropertyValue({ $time: { format: 'HH:mm:ss', timezone: 'UTC' } }, timeContext),
      ).toBe('HH:mm:ss|UTC');
    });

    it('falls back to local formatter without context callback', () => {
      const result = evaluatePropertyValue({ $time: { format: 'HH:mm:ss' } }, mockContext);
      expect(typeof result).toBe('string');
      expect(String(result)).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('$page wrapper', () => {
    const pageContext: EvaluationContext = {
      ...mockContext,
      resolvePage: (field, pageId, separator) => {
        if (field === 'title') return pageId === 'settings' ? 'Settings' : 'Home';
        if (field === 'id') return pageId ?? 'home';
        if (field === 'depth') return 1;
        if (field === 'pathString') return ['Home', 'Settings'].join(separator ?? ' / ');
        if (field === 'breadcrumbLabel') return 'Settings';
        if (field === 'parentId') return 'home';
        return null;
      },
    };

    it('resolves the current active title', () => {
      expect(evaluatePropertyValue({ $page: { field: 'title' } }, pageContext)).toBe('Home');
    });

    it('resolves a named page title', () => {
      expect(
        evaluatePropertyValue({ $page: { field: 'title', pageId: 'settings' } }, pageContext),
      ).toBe('Settings');
    });

    it('honours the separator for pathString', () => {
      expect(
        evaluatePropertyValue({ $page: { field: 'pathString', separator: ' › ' } }, pageContext),
      ).toBe('Home › Settings');
    });

    it('returns null when resolvePage is missing', () => {
      expect(evaluatePropertyValue({ $page: { field: 'title' } }, mockContext)).toBeNull();
    });

    it('returns null for an unknown field', () => {
      expect(evaluatePropertyValue({ $page: { field: 'somethingElse' } }, pageContext)).toBeNull();
    });

    it('plays nicely inside $switch on viewport-style chains', () => {
      const ctx: EvaluationContext = {
        ...pageContext,
        resolveViewport: (f) => (f === 'size' ? 'phone' : null),
      };
      const expr = {
        $switch: {
          value: { $viewport: { field: 'size' } },
          cases: [
            { when: 'phone', then: { $page: { field: 'title' } } },
            { when: 'tablet', then: 'tablet' },
          ],
          default: 'desktop',
        },
      };
      expect(evaluatePropertyValue(expr, ctx)).toBe('Home');
    });
  });

  describe('$viewport wrapper', () => {
    const viewportCtx: EvaluationContext = {
      ...mockContext,
      resolveViewport: (field) => {
        if (field === 'size') return 'tablet';
        if (field === 'width') return 1024;
        if (field === 'height') return 768;
        if (field === 'orientation') return 'landscape';
        return null;
      },
    };

    it('returns the size class', () => {
      expect(evaluatePropertyValue({ $viewport: { field: 'size' } }, viewportCtx)).toBe('tablet');
    });

    it('returns numeric width / height', () => {
      expect(evaluatePropertyValue({ $viewport: { field: 'width' } }, viewportCtx)).toBe(1024);
      expect(evaluatePropertyValue({ $viewport: { field: 'height' } }, viewportCtx)).toBe(768);
    });

    it('returns orientation', () => {
      expect(evaluatePropertyValue({ $viewport: { field: 'orientation' } }, viewportCtx)).toBe(
        'landscape',
      );
    });

    it('returns null for unknown fields', () => {
      expect(evaluatePropertyValue({ $viewport: { field: 'bogus' } }, viewportCtx)).toBeNull();
    });

    it('returns null when resolveViewport is missing', () => {
      expect(evaluatePropertyValue({ $viewport: { field: 'size' } }, mockContext)).toBeNull();
    });
  });

  describe('$result wrapper', () => {
    it('resolves a scalar field from resultValue', () => {
      const ctx: EvaluationContext = { resultValue: { reason: 'invalid_credentials' } };
      expect(evaluatePropertyValue({ $result: 'reason' }, ctx)).toBe('invalid_credentials');
    });

    it('returns null when resultValue is not in context', () => {
      expect(evaluatePropertyValue({ $result: 'reason' })).toBeNull();
    });

    it('returns null for an unknown field on resultValue', () => {
      const ctx: EvaluationContext = { resultValue: { reason: 'x' } };
      expect(evaluatePropertyValue({ $result: 'username' }, ctx)).toBeNull();
    });

    it('returns null when resultValue holds null at that field', () => {
      const ctx: EvaluationContext = { resultValue: { reason: null } };
      expect(evaluatePropertyValue({ $result: 'reason' }, ctx)).toBeNull();
    });

    it('serialises non-scalar fields (arrays / objects) to JSON', () => {
      const ctx: EvaluationContext = { resultValue: { groups: ['operator', 'guest'] } };
      expect(evaluatePropertyValue({ $result: 'groups' }, ctx)).toBe('["operator","guest"]');
    });

    it('returns null for non-string payloads', () => {
      const ctx: EvaluationContext = { resultValue: { reason: 'x' } };
      expect(evaluatePropertyValue({ $result: 42 }, ctx)).toBeNull();
    });

    it('composes with $switch — branch by result reason', () => {
      const ctx: EvaluationContext = {
        ...mockContext,
        resultValue: { reason: 'timeout' },
      };
      const expr = {
        $switch: {
          value: { $result: 'reason' },
          cases: [
            { when: 'invalid_credentials', then: 'wrong password' },
            { when: 'timeout', then: 'try again later' },
          ],
          default: 'unknown',
        },
      };
      expect(evaluatePropertyValue(expr, ctx)).toBe('try again later');
    });

    it('composes with $switch — falls back to default for an unhandled reason', () => {
      const ctx: EvaluationContext = {
        ...mockContext,
        resultValue: { reason: 'disconnected' },
      };
      const expr = {
        $switch: {
          value: { $result: 'reason' },
          cases: [{ when: 'invalid_credentials', then: 'wrong password' }],
          default: 'Connection issue',
        },
      };
      expect(evaluatePropertyValue(expr, ctx)).toBe('Connection issue');
    });
  });

  describe('$componentProp wrapper', () => {
    const scopeCtx: EvaluationContext = {
      ...mockContext,
      inputScopeProps: {
        label: 'Tank A',
        sensor: { $var: { path: 'PLC1:Sensor' } },
      },
    };

    it('resolves a scalar input property from the surrounding scope', () => {
      expect(evaluatePropertyValue({ $componentProp: 'label' }, scopeCtx)).toBe('Tank A');
    });

    it('resolves a slash-path member by extending the parent $var binding', () => {
      const ctx: EvaluationContext = {
        ...scopeCtx,
        resolveVariable: (ds, path) => (ds === 'PLC1' && path === 'Sensor/fValue' ? 42 : null),
      };
      expect(evaluatePropertyValue({ $componentProp: 'sensor/fValue' }, ctx)).toBe(42);
    });

    it('returns null when there is no input scope', () => {
      expect(evaluatePropertyValue({ $componentProp: 'label' }, mockContext)).toBeNull();
    });
  });

  describe('$recipe wrapper', () => {
    const ctx: EvaluationContext = {
      resolveRecipe: (typeId, field) => {
        if (typeId !== 'coffee') return field === 'activeName' ? '' : false;
        if (field === 'activeName') return 'Espresso';
        if (field === 'loaded') return true;
        return true; // parametersChanged
      },
    };

    it('resolves activeName via resolveRecipe', () => {
      expect(evaluatePropertyValue({ $recipe: { type: 'coffee', field: 'activeName' } }, ctx)).toBe(
        'Espresso',
      );
    });

    it('resolves parametersChanged via resolveRecipe', () => {
      expect(
        evaluatePropertyValue({ $recipe: { type: 'coffee', field: 'parametersChanged' } }, ctx),
      ).toBe(true);
    });

    it('falls back without a resolver (boolean field → false)', () => {
      expect(evaluatePropertyValue({ $recipe: { type: 'coffee', field: 'loaded' } }, {})).toBe(
        false,
      );
    });

    it('falls back without a resolver (activeName → empty string)', () => {
      expect(evaluatePropertyValue({ $recipe: { type: 'coffee', field: 'activeName' } }, {})).toBe(
        '',
      );
    });

    it('returns false for a malformed payload', () => {
      expect(evaluatePropertyValue({ $recipe: 'nope' }, ctx)).toBe(false);
    });
  });

  describe('$http wrapper', () => {
    interface Seen {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      refreshMs: number;
    }

    /** Context whose HTTP resolver records the spec and serves a canned body. */
    function httpCtx(data: unknown, seen?: Seen[]): EvaluationContext {
      return {
        ...mockContext,
        resolveHttpRequest: (spec) => {
          seen?.push(spec as unknown as Seen);
          return { status: 'ok', data, fetchedAt: 1 };
        },
      };
    }

    it('picks a scalar out of the JSON response by slash-path', () => {
      const ctx = httpCtx({ data: [{ value: 42 }] });
      expect(
        evaluatePropertyValue({ $http: { url: 'https://x/y', path: 'data/0/value' } }, ctx),
      ).toBe(42);
    });

    it('returns the whole body when no path is given', () => {
      const ctx = httpCtx('plain text');
      expect(evaluatePropertyValue({ $http: { url: 'https://x/y' } }, ctx)).toBe('plain text');
    });

    it('serialises a non-scalar pick to JSON', () => {
      const ctx = httpCtx({ items: [1, 2] });
      expect(evaluatePropertyValue({ $http: { url: 'https://x/y', path: 'items' } }, ctx)).toBe(
        '[1,2]',
      );
    });

    it('returns null for a path that misses', () => {
      const ctx = httpCtx({ data: {} });
      expect(
        evaluatePropertyValue({ $http: { url: 'https://x/y', path: 'data/nope' } }, ctx),
      ).toBeNull();
    });

    it('fills {n} placeholders in the URL from wildcards', () => {
      const seen: Seen[] = [];
      const ctx = httpCtx({ ok: true }, seen);
      evaluatePropertyValue(
        {
          $http: {
            url: 'https://api/devices/{1}/status?mode={ToLower(2)}',
            wildcards: { '1': { $var: { path: 'PLC1:Temperature' } }, '2': 'FAST' },
          },
        },
        ctx,
      );
      expect(seen[0].url).toBe('https://api/devices/42/status?mode=fast');
    });

    it('templates header values and sends the body only for POST', () => {
      const seen: Seen[] = [];
      const ctx = httpCtx({ ok: true }, seen);
      evaluatePropertyValue(
        {
          $http: {
            url: 'https://api/x',
            method: 'POST',
            headers: [
              { name: 'X-Token', value: 'tok-{1}' },
              { name: '   ', value: 'dropped' },
            ],
            body: '{"id": "{1}"}',
            wildcards: { '1': 'abc' },
            refreshSeconds: 5,
          },
        },
        ctx,
      );
      expect(seen[0]).toMatchObject({
        method: 'POST',
        headers: { 'X-Token': 'tok-abc' },
        body: '{"id": "abc"}',
        refreshMs: 5000,
      });
    });

    it('drops the body on GET', () => {
      const seen: Seen[] = [];
      const ctx = httpCtx({ ok: true }, seen);
      evaluatePropertyValue({ $http: { url: 'https://api/x', body: 'ignored' } }, ctx);
      expect(seen[0].body).toBeUndefined();
    });

    it('returns null while the first response is still in flight', () => {
      const ctx: EvaluationContext = { resolveHttpRequest: () => undefined };
      expect(evaluatePropertyValue({ $http: { url: 'https://x/y' } }, ctx)).toBeNull();
    });

    it('returns null for an empty url without calling the resolver', () => {
      const seen: Seen[] = [];
      const ctx = httpCtx({ ok: true }, seen);
      expect(evaluatePropertyValue({ $http: { url: '   ' } }, ctx)).toBeNull();
      expect(seen).toHaveLength(0);
    });

    it('returns null with no resolver in context', () => {
      expect(evaluatePropertyValue({ $http: { url: 'https://x/y' } }, {})).toBeNull();
    });
  });
});
