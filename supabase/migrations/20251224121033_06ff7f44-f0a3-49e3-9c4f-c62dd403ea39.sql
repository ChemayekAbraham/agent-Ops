-- Create role enum
CREATE TYPE public.app_role AS ENUM ('tenant', 'agent', 'landlord', 'supporter', 'manager');

-- Create user profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create user roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, role)
);

-- Create landlords table
CREATE TABLE public.landlords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  bank_name TEXT,
  account_number TEXT,
  mobile_money_number TEXT,
  property_address TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create LC1 chairpersons table
CREATE TABLE public.lc1_chairpersons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  village TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create rent requests table
CREATE TABLE public.rent_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  landlord_id UUID REFERENCES public.landlords(id) NOT NULL,
  lc1_id UUID REFERENCES public.lc1_chairpersons(id) NOT NULL,
  rent_amount DECIMAL(12,2) NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days IN (30, 60, 90)),
  access_fee DECIMAL(12,2) NOT NULL,
  request_fee DECIMAL(12,2) NOT NULL,
  total_repayment DECIMAL(12,2) NOT NULL,
  daily_repayment DECIMAL(12,2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'funded', 'disbursed', 'completed', 'rejected')),
  supporter_id UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  funded_at TIMESTAMP WITH TIME ZONE,
  disbursed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create repayments table
CREATE TABLE public.repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID REFERENCES public.rent_requests(id) ON DELETE CASCADE NOT NULL,
  tenant_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create platform transactions table for tracking all money flows
CREATE TABLE public.platform_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID REFERENCES public.rent_requests(id),
  user_id UUID REFERENCES auth.users(id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'access_fee', 'request_fee', 'rent_repayment', 'supporter_funding',
    'landlord_payout', 'agent_approval_bonus', 'agent_commission', 'supporter_reward'
  )),
  amount DECIMAL(12,2) NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landlords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lc1_chairpersons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_transactions ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Function to get user's role
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id UUID)
RETURNS app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1
$$;

-- Trigger function to create profile and role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    NEW.email
  );
  
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, (NEW.raw_user_meta_data->>'role')::app_role);
  
  RETURN NEW;
END;
$$;

-- Create trigger for new users
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_rent_requests_updated_at
  BEFORE UPDATE ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS Policies

-- Profiles: users can read/update their own
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- User roles: users can view own, managers can view all
CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'manager'));

-- Landlords: tenants can insert, all authenticated can view
CREATE POLICY "Authenticated users can view landlords" ON public.landlords
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Tenants can insert landlords" ON public.landlords
  FOR INSERT TO authenticated WITH CHECK (true);

-- LC1: tenants can insert, all authenticated can view
CREATE POLICY "Authenticated users can view lc1" ON public.lc1_chairpersons
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Tenants can insert lc1" ON public.lc1_chairpersons
  FOR INSERT TO authenticated WITH CHECK (true);

-- Rent requests: complex policies based on role
CREATE POLICY "Tenants view own requests" ON public.rent_requests
  FOR SELECT USING (auth.uid() = tenant_id);

CREATE POLICY "Agents view requests they registered" ON public.rent_requests
  FOR SELECT USING (auth.uid() = agent_id);

CREATE POLICY "Supporters view funded/available requests" ON public.rent_requests
  FOR SELECT USING (
    public.has_role(auth.uid(), 'supporter') AND (status = 'approved' OR auth.uid() = supporter_id)
  );

CREATE POLICY "Managers view all requests" ON public.rent_requests
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Tenants can create requests" ON public.rent_requests
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = tenant_id);

CREATE POLICY "Managers can update requests" ON public.rent_requests
  FOR UPDATE USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Supporters can fund requests" ON public.rent_requests
  FOR UPDATE USING (
    public.has_role(auth.uid(), 'supporter') AND status = 'approved'
  );

-- Repayments: tenants can insert own, view own
CREATE POLICY "Tenants view own repayments" ON public.repayments
  FOR SELECT USING (auth.uid() = tenant_id);

CREATE POLICY "Tenants can make repayments" ON public.repayments
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = tenant_id);

CREATE POLICY "Managers view all repayments" ON public.repayments
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

-- Platform transactions: managers can view all, users can view own
CREATE POLICY "Users view own transactions" ON public.platform_transactions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Managers view all transactions" ON public.platform_transactions
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "System can insert transactions" ON public.platform_transactions
  FOR INSERT TO authenticated WITH CHECK (true);